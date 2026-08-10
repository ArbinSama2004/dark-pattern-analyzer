"""Request/response contracts for /v1/traces.

A trace is what the extension already assembles for its own debugging (see
`exportTrace` in the content script): every candidate the page produced, with
its tag, role, selector, whether it was sent to the model, and what came back.
Storing it is what turns "I noticed a gap on some page once" into something
that can be re-examined without finding and re-scanning the page.

The entry shape here is deliberately permissive about extra keys being absent,
but not about unknown ones: the extension and this schema must not drift
silently, since a field quietly dropped on upload is only discovered much later
when the archive turns out not to contain it.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

#: Bounded so one page cannot post an unbounded body. Real pages top out
#: around 600 candidates (MAX_SNIPPETS_PER_PAGE in the extension); the headroom
#: covers extraction passes that saw more before deduping.
MAX_TRACE_ENTRIES = 5000


class TraceEntry(BaseModel):
    """One candidate's full journey, as the content script recorded it."""

    model_config = ConfigDict(extra="forbid")

    id: str
    text: str
    tag: str = "span"
    role: str = "none"
    step: str | None = None
    selector: str = ""
    ruleHits: list[str] = Field(default_factory=list)
    sentToModel: bool = False
    #: null = never resolved, [] = confirmed benign, non-empty = labels found.
    #: The three are genuinely different and collapsing them would destroy the
    #: main reason to keep the trace at all.
    findingLabels: list[str] | None = None
    firstSeenAt: int = 0
    lastSeenAt: int = 0


class StoreTraceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: Stable per page load. Re-uploading the same scan after more batches
    #: resolve replaces the earlier, less complete capture rather than adding
    #: a near-duplicate.
    scan_id: Annotated[str, Field(min_length=1, max_length=100)]

    url: Annotated[str, Field(min_length=1, max_length=2000)]

    page_score: Annotated[int, Field(ge=0, le=100)] = 0

    entries: Annotated[list[TraceEntry], Field(max_length=MAX_TRACE_ENTRIES)]

    @field_validator("url")
    @classmethod
    def _http_only(cls, v: str) -> str:
        # Keeps chrome://, file:// and data: captures out of the archive.
        # Nothing useful is learned from them and file:// paths in particular
        # leak local directory structure into stored records.
        if not v.startswith(("http://", "https://")):
            raise ValueError("url must be http(s)")
        return v


class StoreTraceResponse(BaseModel):
    scan_id: str
    object_key: str
    bucket: str
    #: True when this replaced an earlier capture of the same scan.
    replaced: bool = False
    entry_count: int


class TraceSummary(BaseModel):
    """One row of the index. Deliberately not the trace itself -- listing
    should stay cheap regardless of how large the stored objects are."""

    scan_id: str
    object_key: str
    host: str
    url: str
    captured_at: str
    candidate_count: int
    flagged_count: int
    page_score: int
    labels: list[str]


class TraceListResponse(BaseModel):
    traces: list[TraceSummary]
    total_indexed: int


TraceSortOrder = Literal["newest"]

__all__ = [
    "MAX_TRACE_ENTRIES",
    "StoreTraceRequest",
    "StoreTraceResponse",
    "TraceEntry",
    "TraceListResponse",
    "TraceSummary",
]
