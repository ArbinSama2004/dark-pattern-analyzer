"""POST /v1/classify -- batch multi-label classification of DOM snippets.

Request handling order, and why:

1. **Build the model input string** through ``core.model_input`` only. One code
   path, guarded by a test against the ml/ source. Invariant #2.
2. **Cache lookup** on a key that includes model version, profile, tag and role.
   Invariant #4.
3. **Dedup within the request.** A product page repeats "Add to cart" dozens of
   times. Collapsing duplicates before the forward pass is free and often halves
   the batch.
4. **One forward pass** in a worker thread, chunked to DP_MAX_BATCH.
5. **Threshold from the bundle**, never a literal. Invariant #3.

The ONNX call is synchronous and CPU-bound, so it runs in a thread via
``run_in_threadpool``. Calling it directly in the coroutine would block the event
loop for the whole 30-60 ms batch and serialise every concurrent request.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool

from app.core.bundle import BundleError, load_bundle
from app.core.hashing import cache_key, snippet_id
from app.core.model_input import build_model_input
from app.core.taxonomy import LABEL_DESCRIPTIONS
from app.schemas.classify import (
    ClassifyMeta,
    ClassifyRequest,
    ClassifyResponse,
    Finding,
    SnippetResult,
)
from app.services.postprocess import decide

log = logging.getLogger(__name__)

router = APIRouter(tags=["classify"])


def _thresholds_for_profile(request: Request, profile: str) -> dict[str, float]:
    """Resolve thresholds for ``profile``, loading and caching alternates lazily.

    The active profile is loaded at startup. A per-request override reads the same
    ``thresholds.json`` for the requested profile and memoises it on app state, so
    a profile sweep costs one extra file read per profile per process and still
    never hardcodes a value.
    """
    engine = request.app.state.engine
    if profile == engine.bundle.profile:
        return engine.bundle.thresholds

    cache: dict[str, dict[str, float]] = request.app.state.alt_thresholds
    if profile not in cache:
        settings = request.app.state.settings
        try:
            alt = load_bundle(
                settings.model_dir,
                profile=profile,
                expected_version=settings.model_version,
                require_onnx=False,
            )
        except BundleError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"threshold profile {profile!r} unavailable: {exc}",
            ) from exc
        cache[profile] = alt.thresholds
    return cache[profile]


@router.post("/classify", response_model=ClassifyResponse)
async def classify(request: Request, payload: ClassifyRequest) -> ClassifyResponse:
    began = time.perf_counter()

    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="model not loaded",
        )

    settings = request.app.state.settings
    cache = request.app.state.cache

    if len(payload.snippets) > settings.max_batch:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"{len(payload.snippets)} snippets exceeds DP_MAX_BATCH="
                f"{settings.max_batch}. Split the request client-side."
            ),
        )

    profile = payload.profile or engine.bundle.profile
    thresholds = _thresholds_for_profile(request, profile)
    threshold_vector = [thresholds[label] for label in engine.labels]

    # --- 1/2: build inputs and look up the cache -------------------------
    keys: list[str] = []
    model_inputs: list[str] = []
    for snippet in payload.snippets:
        model_inputs.append(build_model_input(snippet.text, snippet.tag, snippet.role))
        keys.append(
            cache_key(
                model_version=engine.bundle.model_version,
                profile=profile,
                lang=snippet.lang,
                tag=snippet.tag,
                role=snippet.role,
                text=snippet.text,
            )
        )

    cached: dict[str, dict] = {}
    if payload.use_cache:
        cached = cache.get_many(list(dict.fromkeys(keys)))

    # --- 3: dedup the misses --------------------------------------------
    # Keyed on the model input string, because that is literally what the model
    # sees; two snippets with the same text but different roles are not duplicates.
    pending_index: dict[str, int] = {}
    pending_texts: list[str] = []
    for key, model_input in zip(keys, model_inputs, strict=True):
        if key in cached:
            continue
        if model_input not in pending_index:
            pending_index[model_input] = len(pending_texts)
            pending_texts.append(model_input)

    # --- 4: one forward pass, off the event loop ------------------------
    inference_ms = 0.0
    decisions: list[dict] = []
    if pending_texts:
        probs, inference_ms = await run_in_threadpool(engine.predict_probs, pending_texts)
        decisions = decide(
            probs,
            labels=engine.labels,
            thresholds=threshold_vector,
        )

    # --- 5: assemble, and write fresh results back to the cache ---------
    fresh: dict[str, dict] = {}
    results: list[SnippetResult] = []
    cache_hits = 0

    for snippet, key, model_input in zip(payload.snippets, keys, model_inputs, strict=True):
        hit = cached.get(key)
        if hit is not None:
            decision = hit
            cache_hits += 1
            was_cached = True
        else:
            decision = decisions[pending_index[model_input]]
            fresh[key] = decision
            was_cached = False

        findings = [
            Finding(
                label=str(item["label"]),
                score=float(item["score"]),
                threshold=float(item["threshold"]),
                confidence="possible",
                source=["model"],
                description=LABEL_DESCRIPTIONS.get(str(item["label"]), ""),
            )
            for item in decision["findings"]
        ]

        results.append(
            SnippetResult(
                snippet_id=snippet_id(snippet.text, snippet.lang),
                ref=snippet.ref,
                findings=findings,
                benign=bool(decision["benign"]),
                benign_score=float(decision["benign_score"]),
                scores=dict(decision["scores"]) if payload.include_all_scores else None,
                cached=was_cached,
            )
        )

    if payload.use_cache and fresh:
        cache.set_many(fresh)

    total_ms = (time.perf_counter() - began) * 1000
    if total_ms > 100:
        # The documented budget is <100 ms end to end. fp32 MuRIL on CPU will
        # exceed it for full batches; log it rather than pretending otherwise.
        log.info(
            "classify exceeded the 100 ms budget: %.1f ms total, %.1f ms inference, "
            "%d snippets, %d inferred",
            total_ms,
            inference_ms,
            len(payload.snippets),
            len(pending_texts),
        )

    return ClassifyResponse(
        results=results,
        meta=ClassifyMeta(
            model_version=engine.bundle.model_version,
            base_model=engine.bundle.base_model,
            dataset=engine.bundle.dataset,
            quantization=engine.bundle.quantization,
            threshold_profile=profile,
            snippet_count=len(payload.snippets),
            cache_hits=cache_hits,
            inferred=len(pending_texts),
            inference_ms=round(inference_ms, 2),
            total_ms=round(total_ms, 2),
        ),
    )
