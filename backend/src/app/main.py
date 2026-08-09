"""App factory and lifespan.

The whole point of this file is that the ONNX session is created **once**, here,
and never per request. Everything expensive and everything contract-critical
happens during ``lifespan`` startup, before the first request is accepted:

- load and verify the artifact bundle (label order, model version, thresholds)
- create the ONNX session and the tokenizer
- run the reference smoke check
- run a warmup pass so the first user request is not the one that pays for it

Startup failure policy: the process starts but ``/readyz`` returns 503 with the
reason. Crashing on boot gives an operator a restart loop and no message; a live
process that reports exactly why it cannot serve is far easier to diagnose. It
will never serve a prediction in that state, because ``/v1/classify`` also
returns 503 while ``engine`` is None.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1.health import router as health_router
from app.api.v1.router import v1_router
from app.core.bundle import load_bundle
from app.core.logging import configure_logging
from app.services.cache import PredictionCache
from app.services.inference import InferenceEngine
from app.settings import Settings, get_settings

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings

    app.state.engine = None
    app.state.smoke = None
    app.state.startup_error = None
    app.state.alt_thresholds = {}
    app.state.cache = PredictionCache(
        max_entries=settings.cache_max_entries,
        ttl_seconds=settings.cache_ttl,
    )

    try:
        bundle = load_bundle(
            settings.model_dir,
            profile=settings.threshold_profile,
            expected_version=settings.model_version,
        )
        log.info("bundle verified: %s", bundle.describe())

        engine = InferenceEngine(
            bundle,
            max_batch=settings.max_batch,
            intra_op_threads=settings.onnx_intra_op_threads,
        )

        smoke = engine.smoke_check()
        log.info(smoke.message()) if smoke.passed else log.error(smoke.message())
        if not smoke.passed:
            log.error(
                "The reference input scored %.3f for %s instead of %.3f. This is the "
                "signature of a damaged or mismatched graph -- an int8 collapse or a "
                "pointer file whose weights live in an external .data sidecar. "
                "Refusing readiness. Re-export fp32 and re-run the parity test.",
                smoke.observed,
                smoke.label,
                smoke.expected,
            )

        engine.warmup()

        app.state.engine = engine
        app.state.smoke = smoke

        if settings.redis_url:
            log.warning(
                "DP_REDIS_URL is set but the Redis cache backend is deferred to "
                "Stage 2 hardening. Using the in-process cache."
            )
        if settings.database_url:
            log.warning(
                "DP_DATABASE_URL is set but persistence and /v1/feedback are Stage 4. "
                "Ignoring it."
            )

    except Exception as exc:  # noqa: BLE001 - recorded and surfaced via /readyz
        app.state.startup_error = exc
        log.exception("startup failed; /readyz will report not_ready")

    yield

    app.state.engine = None
    app.state.cache.clear()


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="Dark Pattern Analyzer API",
        version=__version__,
        summary="Multi-label classification of potentially manipulative interface copy.",
        description=(
            "Classifies short interface text into seven potentially manipulative "
            "pattern classes plus benign, in English, Hindi and Nepali. Outputs are "
            "heuristic signals for human review, not legal determinations."
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_methods=["POST", "GET"],
            allow_headers=["content-type"],
        )

    app.include_router(health_router)
    app.include_router(v1_router)
    return app


app = create_app()
