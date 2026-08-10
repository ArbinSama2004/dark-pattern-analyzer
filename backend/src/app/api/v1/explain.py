"""POST /v1/explain -- plain-language explanation of one already-made finding.

Deliberately *not* part of the classify path. Explanations are generated on
demand, one at a time, when a user expands a finding in the side panel. Folding
them into /v1/classify would put a multi-second generation in front of every
badge on a page that already takes 40-80s to classify at 600 candidates, to
produce text almost none of which anyone reads.

This endpoint cannot change a classification. It receives a finding that has
already been decided and returns prose about it; there is no path from its
response back into a label, a score or the page score. See services/explain.py
for the prompt policy and the wording-discipline enforcement.

Availability is explicit: when DP_LLM_ENABLED is false the route returns 503
with a reason rather than pretending to work, and the extension uses that to
hide its own control instead of offering a button that always fails.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, HTTPException, Request, status

from app.schemas.explain import ExplainRequest, ExplainResponse
from app.services.explain import cache_key, generate_explanation, validate_label
from app.services.llm import LLMError

log = logging.getLogger(__name__)

router = APIRouter(tags=["explain"])


@router.post(
    "/explain",
    response_model=ExplainResponse,
    summary="Explain one finding in plain language.",
    responses={
        400: {"description": "Label outside the taxonomy."},
        502: {"description": "The model provider failed in a way retrying will not fix."},
        503: {"description": "Explanations are disabled or the provider is unreachable."},
    },
)
async def explain(request: Request, body: ExplainRequest) -> ExplainResponse:
    client = getattr(request.app.state, "llm_client", None)
    if client is None:
        # The reason is decided at startup (see main.py's lifespan), because
        # only startup knows *which* piece of configuration is missing --
        # "not enabled" and "enabled but no API key" need different fixes and
        # a single generic message sends the operator to the wrong setting.
        reason = getattr(request.app.state, "llm_disabled_reason", None)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=reason or "LLM explanations are unavailable on this server.",
        )

    try:
        validate_label(body.label)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    cache = request.app.state.explanation_cache
    key = cache_key(body, client.model)

    if body.use_cache:
        hit = cache.get(key)
        if hit is not None:
            return ExplainResponse(
                explanation=hit["explanation"],
                label=body.label,
                cached=True,
                model=client.model,
            )

    started = time.perf_counter()
    try:
        explanation = await generate_explanation(client, body)
    except LLMError as exc:
        # Retryable failures (provider down, timeout, rate limited) are 503 --
        # the request was fine and may succeed later. Everything else is 502:
        # the upstream answered, but unusably.
        code = status.HTTP_503_SERVICE_UNAVAILABLE if exc.retryable else status.HTTP_502_BAD_GATEWAY
        log.warning("explain failed (label=%s, retryable=%s): %s", body.label, exc.retryable, exc)
        raise HTTPException(status_code=code, detail=str(exc)) from exc

    generation_ms = (time.perf_counter() - started) * 1000.0
    cache.set(key, {"explanation": explanation})

    log.info(
        "explained label=%s in %.0fms (model=%s, context=%d)",
        body.label,
        generation_ms,
        client.model,
        len(body.context),
    )

    return ExplainResponse(
        explanation=explanation,
        label=body.label,
        cached=False,
        model=client.model,
        generation_ms=generation_ms,
    )


__all__ = ["router"]
