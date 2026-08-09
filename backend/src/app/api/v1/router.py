"""v1 router assembly.

Health probes are mounted at the app root (``/healthz``, ``/readyz``) rather than
under ``/v1``, because they describe the process, not the API version. The
classify endpoint is versioned, because its response shape is a contract the
extension depends on.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.v1 import classify

v1_router = APIRouter(prefix="/v1")
v1_router.include_router(classify.router)

__all__ = ["v1_router"]
