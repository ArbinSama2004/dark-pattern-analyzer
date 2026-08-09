"""Liveness and readiness probes.

The split matters for deployment. ``/healthz`` answers "is the process alive" and
must stay cheap and dependency-free. ``/readyz`` answers "can this process serve a
prediction", which means the bundle loaded, the ONNX session exists and the
reference smoke check passed. A load balancer that routes on /healthz alone will
happily send traffic to a process whose model is missing.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status

from app.schemas.classify import HealthResponse, ReadyResponse

router = APIRouter(tags=["health"])


@router.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    """Liveness. Deliberately does not touch the model."""
    return HealthResponse(status="ok")


@router.get("/readyz", response_model=ReadyResponse)
async def readyz(request: Request, response: Response) -> ReadyResponse:
    """Readiness. 503 until the engine is loaded and the smoke check has passed."""
    engine = getattr(request.app.state, "engine", None)
    startup_error = getattr(request.app.state, "startup_error", None)

    if startup_error is not None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadyResponse(status="not_ready", detail=str(startup_error))

    if engine is None:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadyResponse(status="not_ready", detail="inference engine not loaded")

    smoke = getattr(request.app.state, "smoke", None)
    if smoke is not None and not smoke.passed:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return ReadyResponse(
            status="not_ready",
            detail=smoke.message(),
            model=engine.bundle.describe(),
        )

    return ReadyResponse(
        status="ready",
        detail=smoke.message() if smoke is not None else None,
        model=engine.bundle.describe(),
    )
