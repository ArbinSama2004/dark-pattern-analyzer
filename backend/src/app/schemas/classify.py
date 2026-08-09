"""Request/response contracts for POST /v1/classify.

Wording discipline is part of the contract. The service returns
``potentially manipulative`` findings with a confidence and a source. It never
emits "illegal", "violation" or "fraud" -- that is a legal verdict this project
is not entitled to make, and the extension copy depends on it.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.model_input import normalize_role, normalize_tag
from app.core.taxonomy import LANGS

#: Longer than this and the snippet is not a UI microcopy string; max_length=64
#: tokens covers >99% of training rows and p95 is 34 tokens. Truncation happens
#: in the tokenizer anyway, but a cap keeps request bodies bounded.
MAX_TEXT_CHARS = 2000


class Snippet(BaseModel):
    """One DOM text node with its structural context."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=MAX_TEXT_CHARS)]

    #: HTML tag name. Lowercased on the way in: training never saw "P".
    tag: str = "span"

    #: Semantic role inferred by the extension (cta, decline, fine_print, ...).
    role: str = "none"

    #: Language of the snippet. Used only for the snippet id and per-language
    #: telemetry -- the model itself is multilingual and is not told the language.
    lang: Literal["en", "hi", "ne"] = "en"

    #: Optional caller-supplied handle, echoed back so the extension can map
    #: results onto DOM nodes without relying on array order.
    ref: str | None = Field(default=None, max_length=200)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("text must contain non-whitespace characters")
        return v

    @field_validator("tag")
    @classmethod
    def _norm_tag(cls, v: str) -> str:
        return normalize_tag(v)

    @field_validator("role")
    @classmethod
    def _norm_role(cls, v: str) -> str:
        return normalize_role(v)


class ClassifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snippets: Annotated[list[Snippet], Field(min_length=1)]

    #: Optional per-request profile override. Omit to use DP_THRESHOLD_PROFILE.
    #: Present so the Stage 4 evaluation can sweep profiles without a redeploy.
    profile: Literal["precision", "balanced", "recall"] | None = None

    #: Set false to bypass the cache for this request (debugging, benchmarking).
    use_cache: bool = True

    #: When true, every class score is returned, not only those over threshold.
    include_all_scores: bool = False


class Finding(BaseModel):
    """One class whose score cleared its tuned threshold."""

    label: str
    score: float
    threshold: float

    #: "possible" for a model-only detection. Stage 3's rule engine upgrades a
    #: rule+model agreement to "likely"; the backend never emits "likely"
    #: because it does not run the rules.
    confidence: Literal["possible", "likely"] = "possible"

    #: Provenance for the Stage 3 merge policy.
    source: list[Literal["model", "rule"]] = Field(default_factory=lambda: ["model"])

    description: str = ""


class SnippetResult(BaseModel):
    """Per-snippet prediction."""

    #: sha1(lang + NUL + text).
    snippet_id: str

    #: Echo of Snippet.ref, if the caller supplied one.
    ref: str | None = None

    #: Findings over threshold, benign excluded, highest score first.
    findings: list[Finding] = Field(default_factory=list)

    #: True when no manipulative class cleared its threshold. This is the
    #: absence of a detection, not a positive "this site is honest" claim.
    benign: bool = True

    #: Score of the benign class, for transparency. Not a decision input.
    benign_score: float = 0.0

    #: All eight class scores, only when include_all_scores was requested.
    scores: dict[str, float] | None = None

    #: True when this result came from cache rather than a fresh forward pass.
    cached: bool = False


class ClassifyMeta(BaseModel):
    """What produced these predictions. Enough to reproduce them."""

    model_version: str
    base_model: str
    dataset: str
    quantization: str
    threshold_profile: str

    snippet_count: int
    cache_hits: int

    #: Snippets that needed a forward pass after cache and in-request dedup.
    inferred: int

    #: Wall-clock milliseconds spent inside the ONNX session.
    inference_ms: float

    #: Total handler time in milliseconds.
    total_ms: float


class ClassifyResponse(BaseModel):
    results: list[SnippetResult]
    meta: ClassifyMeta


class HealthResponse(BaseModel):
    status: Literal["ok"]


class ReadyResponse(BaseModel):
    status: Literal["ready", "not_ready"]
    detail: str | None = None
    model: dict[str, object] | None = None


__all__ = [
    "ClassifyMeta",
    "ClassifyRequest",
    "ClassifyResponse",
    "Finding",
    "HealthResponse",
    "LANGS",
    "ReadyResponse",
    "Snippet",
    "SnippetResult",
]
