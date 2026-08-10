"""Typed configuration. Every knob is an env var prefixed ``DP_``.

Nothing about the model contract lives here. Labels come from
``label_map.json`` and thresholds come from ``thresholds.json``, both inside the
artifact bundle. This file only says *where* the bundle is and *how* to serve it.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: ``backend/.env``, resolved from this file rather than from the working
#: directory.
#:
#: This was ``env_file=".env"``, which pydantic-settings resolves relative to
#: **CWD**. Every process that happened to start somewhere other than
#: ``backend/`` therefore silently loaded no configuration at all and fell back
#: to defaults -- including ``DP_MODEL_DIR``, whose default is relative and
#: points outside the repo from any other directory. There is also an empty
#: ``.env`` at the repo root (Docker Compose reads one there for its own
#: variable interpolation), so a backend process started from the root would
#: read *that* file, find nothing, and report a mystery misconfiguration.
#:
#: Anchoring it here means `uv run python scripts/...` behaves the same from
#: any directory. A real environment variable still wins over the file, which
#: is what deployments use.
_BACKEND_ENV = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DP_",
        env_file=_BACKEND_ENV,
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- artifact bundle ---------------------------------------------------

    #: Directory produced by Stage 1. Must contain model.onnx, tokenizer/,
    #: label_map.json, thresholds.json, manifest.json.
    model_dir: Path = Path("../ml/artifacts/model_v1")

    #: Declared model version. Cross-checked against manifest.json at startup;
    #: a mismatch is fatal, because this value is baked into every cache key
    #: and a silent mismatch serves stale predictions after a retrain.
    model_version: str = "1.0.0"

    #: Which profile in thresholds.json to serve. "recall" is intentionally
    #: allowed but is known-bad for social_proof (precision 0.230); the loader
    #: logs a warning rather than refusing, so an operator can still A/B it.
    threshold_profile: str = "precision"

    # --- serving -----------------------------------------------------------

    #: Maximum snippets accepted in one request, and the ONNX batch chunk size.
    max_batch: int = 64

    #: onnxruntime intra-op thread count. 0 lets ORT decide.
    onnx_intra_op_threads: int = 0

    #: Cache entry lifetime in seconds. 7 days.
    cache_ttl: int = 604800

    #: Maximum number of cached snippet results held in process.
    cache_max_entries: int = 50_000

    # --- LLM explanations (POST /v1/explain) -------------------------------
    #
    # Provider is Groq. The client speaks the OpenAI chat-completions wire
    # format, so any OpenAI-compatible endpoint would also work by changing
    # these variables -- but Groq is what this is configured and tested for.
    #
    # DP_LLM_API_KEY is a real secret. It is read from the environment on the
    # *server* and never leaves it. It must never be placed in the extension
    # bundle, which is world-readable to anyone who installs it -- that is the
    # reason explanations are a backend endpoint rather than a direct call
    # from the side panel.

    #: Master switch. When false, /v1/explain returns 503 with a clear reason
    #: instead of half-working -- the extension disables its own control on
    #: that signal rather than offering a button that always errors.
    llm_enabled: bool = False

    #: OpenAI-compatible base URL, including the version path segment.
    llm_base_url: str = "https://api.groq.com/openai/v1"

    #: Model identifier as Groq names it. Groq's catalogue changes; check
    #: https://console.groq.com/docs/models if this one stops resolving.
    llm_model: str = "llama-3.3-70b-versatile"

    #: Sent as `Authorization: Bearer`. Empty by default so an unconfigured
    #: server fails with "no API key" rather than a confusing 401 from Groq.
    #: Set it in backend/.env (gitignored) or the process environment.
    llm_api_key: str = ""

    #: Per-request timeout in seconds. Groq is fast -- this is generous enough
    #: to absorb a queue spike without being long enough that a wedged request
    #: holds the UI's pending state indefinitely.
    llm_timeout: float = 45.0

    #: Upper bound on generated length. Explanations are a short paragraph;
    #: this is a cost and latency guard, not a quality knob.
    llm_max_tokens: int = 400

    #: Low but not zero -- explanations read as stilted at 0.0 and start
    #: inventing specifics above ~0.5.
    llm_temperature: float = 0.2

    #: Cached explanations held in process. Far smaller than the prediction
    #: cache: explanations are only generated for findings a user actually
    #: clicked, which is a tiny fraction of classified snippets.
    llm_cache_max_entries: int = 2_000

    # --- trace storage (POST /v1/traces) -----------------------------------
    #
    # Archives the extension's full extraction->classification trace per page
    # scan, so gaps found later (a rule that never fires on real phrasing, a
    # role misinference) can be investigated against real captures instead of
    # needing the page to be re-found and re-scanned.
    #
    # Objects go to MinIO (S3-compatible); a small SQLite index alongside makes
    # them queryable by host/label/date. Object storage alone cannot answer
    # "which Daraz scans had scarcity findings" without downloading everything,
    # which is why the index exists rather than a key convention alone.
    #
    # PRIVACY: a trace contains real text from pages the user visited. This is
    # off by default, and the extension only uploads when the user presses its
    # "Save this scan to the archive" button -- there is no automatic path.

    #: Master switch. When false, /v1/traces returns 503 and stores nothing.
    minio_enabled: bool = False

    #: S3 API endpoint. The MinIO console (:9001) is a different port and will
    #: not work here.
    minio_endpoint: str = "http://localhost:9000"

    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"

    #: Created on first use if absent.
    minio_bucket: str = "dp-traces"

    #: Region name. MinIO ignores it, but boto3 requires one to sign requests.
    minio_region: str = "us-east-1"

    #: SQLite index of stored traces. Relative paths resolve from backend/.
    trace_index_path: Path = Path("./trace_index.db")

    #: Reject payloads larger than this (bytes). A trace of a large page is
    #: ~1-2 MB; this is a guard against an unbounded body, not a tuning knob.
    trace_max_bytes: int = 32 * 1024 * 1024

    # --- deferred, declared so the env contract does not change later ------

    #: Stage 2 hardening. When None (the default) the in-process cache is used.
    redis_url: str | None = None

    #: Stage 4. Unused until /v1/feedback exists.
    database_url: str | None = None

    #: Stage 4. Inert while database_url is None.
    persist_findings: bool = True

    # --- ops ---------------------------------------------------------------

    log_level: str = "INFO"

    #: Browser-extension origins allowed to call the API. Empty disables CORS.
    cors_origins: list[str] = Field(default_factory=list)

    @field_validator("threshold_profile")
    @classmethod
    def _known_profile(cls, v: str) -> str:
        allowed = {"precision", "balanced", "recall"}
        if v not in allowed:
            raise ValueError(f"threshold_profile must be one of {sorted(allowed)}, got {v!r}")
        return v

    @field_validator("max_batch")
    @classmethod
    def _sane_batch(cls, v: int) -> int:
        if not 1 <= v <= 256:
            raise ValueError(f"max_batch must be in 1..256, got {v}")
        return v

    @property
    def tokenizer_file(self) -> Path:
        return self.model_dir / "tokenizer" / "tokenizer.json"

    @property
    def onnx_file(self) -> Path:
        return self.model_dir / "model.onnx"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton."""
    return Settings()
