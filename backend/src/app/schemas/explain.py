"""Request/response contracts for POST /v1/explain.

The same wording discipline as classify.py applies and is enforced twice: once
in the system prompt, and once by rejecting generated text that breaks it (see
services/explain.py). The service explains *potentially manipulative* findings.
It never emits "illegal", "violation" or "fraud" -- that is a legal verdict this
project is not entitled to make.

Scope note: this endpoint explains a finding the fine-tuned model already made.
It cannot change a label, a score or a confidence. That is deliberate -- the
classifier is the source of truth for *what* was detected, and the LLM is a
presentation layer over *why it matters*. Nothing in this response shape gives
the caller a way to feed a label back into the pipeline.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.model_input import normalize_role, normalize_tag

#: Same cap as Snippet.text -- the flagged text is a UI microcopy string.
MAX_TEXT_CHARS = 2000

#: Surrounding candidates carried for context. Ten is enough to establish
#: "this countdown sits next to a price and an add-to-cart button" without
#: turning a per-click explanation into a whole-page prompt.
MAX_CONTEXT_SNIPPETS = 10

#: Context entries are for orientation, not analysis. Truncating them keeps a
#: single overlong neighbour (a product description) from dominating the prompt.
MAX_CONTEXT_CHARS = 200


class ContextSnippet(BaseModel):
    """One nearby extracted candidate, for situational context only."""

    model_config = ConfigDict(extra="forbid")

    text: Annotated[str, Field(min_length=1, max_length=MAX_CONTEXT_CHARS)]
    tag: str = "span"
    role: str = "none"

    @field_validator("tag")
    @classmethod
    def _norm_tag(cls, v: str) -> str:
        return normalize_tag(v)

    @field_validator("role")
    @classmethod
    def _norm_role(cls, v: str) -> str:
        return normalize_role(v)


class ExplainRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    #: The flagged text itself.
    text: Annotated[str, Field(min_length=1, max_length=MAX_TEXT_CHARS)]

    #: The label the fine-tuned model (or a local rule) assigned. Validated
    #: against the taxonomy in the handler, not here, so the error message can
    #: name the allowed set.
    label: Annotated[str, Field(min_length=1, max_length=64)]

    tag: str = "span"
    role: str = "none"
    lang: Literal["en", "hi", "ne"] = "en"

    #: Merged confidence from the extension's rule/model merge policy.
    confidence: Literal["possible", "likely"] = "possible"

    #: Where the evidence came from. Drives how hedged the explanation is:
    #: a model-only finding gets explicitly weaker language than one a
    #: structural rule corroborated.
    source: list[Literal["model", "rule"]] = Field(default_factory=lambda: ["model"])

    #: Model score and threshold, when the finding had model evidence.
    score: float | None = None
    threshold: float | None = None

    #: Names of local structural rules that fired, e.g. ["countdown_timer"].
    rule_hits: list[Annotated[str, Field(max_length=64)]] = Field(default_factory=list)

    #: Nearby candidates from the same page extraction.
    context: Annotated[
        list[ContextSnippet], Field(max_length=MAX_CONTEXT_SNIPPETS)
    ] = Field(default_factory=list)

    #: Bypass the explanation cache for this request.
    use_cache: bool = True

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


class ExplainResponse(BaseModel):
    #: The generated explanation. Plain prose, no markdown headings.
    explanation: str

    #: Echo of the label explained. The caller already knows it; echoing it
    #: makes it obvious in logs and in the UI that the explanation belongs to
    #: this finding and not a stale one from a previous click.
    label: str

    #: True when served from cache rather than a fresh generation.
    cached: bool = False

    #: Which model produced it, for the disclosure line in the UI. Users are
    #: entitled to know a different system wrote this text than flagged it.
    model: str

    #: Wall-clock milliseconds spent waiting on the provider. 0 for a cache hit.
    generation_ms: float = 0.0


__all__ = [
    "ContextSnippet",
    "ExplainRequest",
    "ExplainResponse",
    "MAX_CONTEXT_SNIPPETS",
]
