"""POST /v1/traces -- archive one page scan.  GET /v1/traces -- find archived ones.

Writes go to two places that can disagree: the object store holds the trace,
the SQLite index holds what is needed to find it. The object is written first
and the index second, on purpose. If the process dies between them the result
is an object with no index row -- invisible to queries but recoverable by
re-reading the bucket. The other order would leave an index row pointing at an
object that does not exist, which looks like data until you try to open it.

The blob storage is synchronous and network-bound, so it runs in a threadpool
via run_in_threadpool rather than blocking the event loop for the whole upload,
for the same reason the ONNX forward pass does in classify.py.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.concurrency import run_in_threadpool

from app.schemas.traces import (
    StoreTraceRequest,
    StoreTraceResponse,
    TraceListResponse,
    TraceSummary,
)
from app.services.object_store import ObjectStoreError, build_object_key
from app.services.trace_index import TraceRecord

log = logging.getLogger(__name__)

router = APIRouter(tags=["traces"])


def _require_storage(request: Request):
    store = getattr(request.app.state, "object_store", None)
    index = getattr(request.app.state, "trace_index", None)
    if store is None or index is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Trace storage is not enabled on this server. Set DP_MINIO_ENABLED=true "
                "in backend/.env, start MinIO (docker compose up -d minio), and restart."
            ),
        )
    return store, index


@router.post(
    "/traces",
    response_model=StoreTraceResponse,
    summary="Archive one page scan's full extraction trace.",
    responses={
        503: {"description": "Trace storage disabled, or the object store is unreachable."},
    },
)
async def store_trace(request: Request, body: StoreTraceRequest) -> StoreTraceResponse:
    store, index = _require_storage(request)
    settings = request.app.state.settings

    payload = json.dumps(body.model_dump(), ensure_ascii=False).encode("utf-8")
    if len(payload) > settings.trace_max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=(
                f"trace is {len(payload)} bytes, over the {settings.trace_max_bytes} limit"
            ),
        )

    captured_at = datetime.now(UTC)
    object_key = build_object_key(body.url, body.scan_id, captured_at)

    try:
        await run_in_threadpool(store.put_json, object_key, payload)
    except ObjectStoreError as exc:
        log.warning("trace upload failed (scan_id=%s): %s", body.scan_id, exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc

    # Derived once here rather than recomputed per query later.
    labels = sorted(
        {label for entry in body.entries for label in (entry.findingLabels or [])}
    )
    flagged = sum(1 for entry in body.entries if entry.findingLabels)

    existing = await run_in_threadpool(index.get, body.scan_id)
    await run_in_threadpool(
        index.upsert,
        TraceRecord(
            scan_id=body.scan_id,
            object_key=object_key,
            host=urlparse(body.url).hostname or "unknown-host",
            url=body.url,
            captured_at=captured_at.isoformat(),
            candidate_count=len(body.entries),
            flagged_count=flagged,
            page_score=body.page_score,
            labels=labels,
        ),
    )

    log.info(
        "archived scan %s: %d candidates, %d flagged -> %s",
        body.scan_id,
        len(body.entries),
        flagged,
        object_key,
    )

    return StoreTraceResponse(
        scan_id=body.scan_id,
        object_key=object_key,
        bucket=store.bucket,
        replaced=existing is not None,
        entry_count=len(body.entries),
    )


@router.get(
    "/traces",
    response_model=TraceListResponse,
    summary="Find archived scans by host and/or label.",
)
async def list_traces(
    request: Request,
    host: str | None = Query(default=None, description="Exact hostname, e.g. daraz.com.np"),
    label: str | None = Query(default=None, description="Only scans containing this label"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> TraceListResponse:
    _, index = _require_storage(request)

    records = await run_in_threadpool(
        index.query, host=host, label=label, limit=limit, offset=offset
    )
    total = await run_in_threadpool(index.count)

    return TraceListResponse(
        traces=[TraceSummary(**record.__dict__) for record in records],
        total_indexed=total,
    )


__all__ = ["router"]
