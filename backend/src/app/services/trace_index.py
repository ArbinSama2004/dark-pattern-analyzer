"""Queryable index over the traces stored in object storage.

Object storage answers "give me this key" and "list keys under this prefix"
and nothing else. The questions this project actually asks -- "which captures
contain a scarcity finding", "what have we captured from daraz.com.np this
month", "find the capture where stock_counter should have fired" -- are
content questions, and answering them from S3 alone means downloading every
object. This table is what makes them one query instead.

SQLite rather than Postgres: the index is derived data. If it is lost it can be
rebuilt by re-reading the bucket, so it does not warrant a service to operate.
Its schema is deliberately flat and small -- the trace itself stays in object
storage, and only what is needed to *find* a trace is duplicated here.
"""

from __future__ import annotations

import logging
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS traces (
    scan_id         TEXT PRIMARY KEY,
    object_key      TEXT NOT NULL,
    host            TEXT NOT NULL,
    url             TEXT NOT NULL,
    captured_at     TEXT NOT NULL,
    candidate_count INTEGER NOT NULL,
    flagged_count   INTEGER NOT NULL,
    page_score      INTEGER NOT NULL,
    -- Comma-delimited, wrapped in commas (",scarcity,social_proof,") so a
    -- LIKE '%,scarcity,%' cannot match a label that merely shares a prefix.
    -- A junction table would be more correct; for a handful of labels on a
    -- local index it would be more machinery than the query needs.
    labels          TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS traces_host_idx ON traces (host, captured_at DESC);
CREATE INDEX IF NOT EXISTS traces_captured_idx ON traces (captured_at DESC);
"""


@dataclass(frozen=True)
class TraceRecord:
    scan_id: str
    object_key: str
    host: str
    url: str
    captured_at: str
    candidate_count: int
    flagged_count: int
    page_score: int
    labels: list[str]


def encode_labels(labels: list[str]) -> str:
    """Comma-wrapped label set, deduped and ordered for stable comparison."""
    unique = sorted({label for label in labels if label})
    return f",{','.join(unique)}," if unique else ""


def decode_labels(encoded: str) -> list[str]:
    return [label for label in encoded.strip(",").split(",") if label]


class TraceIndex:
    def __init__(self, path: Path) -> None:
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            # WAL so a read (the query endpoint) is never blocked by a
            # concurrent write (an upload landing) -- the default journal mode
            # would serialise them and surface as sporadic "database is
            # locked" errors under exactly the load this sees.
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # A connection per operation rather than one shared: FastAPI runs sync
        # work on a threadpool, and a SQLite connection is not safe to share
        # across threads. Connections are cheap; correctness here is not.
        conn = sqlite3.connect(self._path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def upsert(self, record: TraceRecord) -> None:
        """Insert, or replace an earlier capture of the same scan.

        Upsert rather than insert because a scan is uploaded when it settles
        and may be re-uploaded after later batches resolve more candidates.
        The scan id is stable per page load, so the newer, more complete
        capture replaces the earlier one instead of both persisting.
        """
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO traces (
                    scan_id, object_key, host, url, captured_at,
                    candidate_count, flagged_count, page_score, labels
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scan_id) DO UPDATE SET
                    object_key      = excluded.object_key,
                    host            = excluded.host,
                    url             = excluded.url,
                    captured_at     = excluded.captured_at,
                    candidate_count = excluded.candidate_count,
                    flagged_count   = excluded.flagged_count,
                    page_score      = excluded.page_score,
                    labels          = excluded.labels
                """,
                (
                    record.scan_id,
                    record.object_key,
                    record.host,
                    record.url,
                    record.captured_at,
                    record.candidate_count,
                    record.flagged_count,
                    record.page_score,
                    encode_labels(record.labels),
                ),
            )

    def query(
        self,
        *,
        host: str | None = None,
        label: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[TraceRecord]:
        clauses: list[str] = []
        params: list[object] = []
        if host:
            clauses.append("host = ?")
            params.append(host)
        if label:
            # The comma wrapping is what makes this exact: '%,social_proof,%'
            # cannot match ',social_proof_extra,'.
            clauses.append("labels LIKE ?")
            params.append(f"%,{label},%")

        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])

        with self._connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM traces {where} ORDER BY captured_at DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        return [_row_to_record(row) for row in rows]

    def get(self, scan_id: str) -> TraceRecord | None:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM traces WHERE scan_id = ?", (scan_id,)).fetchone()
        return _row_to_record(row) if row else None

    def count(self) -> int:
        with self._connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM traces").fetchone()[0])


def _row_to_record(row: sqlite3.Row) -> TraceRecord:
    return TraceRecord(
        scan_id=row["scan_id"],
        object_key=row["object_key"],
        host=row["host"],
        url=row["url"],
        captured_at=row["captured_at"],
        candidate_count=row["candidate_count"],
        flagged_count=row["flagged_count"],
        page_score=row["page_score"],
        labels=decode_labels(row["labels"]),
    )


__all__ = ["TraceIndex", "TraceRecord", "decode_labels", "encode_labels"]
