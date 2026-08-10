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


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="DP_",
        env_file=".env",
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
    # Ollama and Groq both speak the OpenAI chat-completions wire format, so
    # one client covers both and switching providers is three env vars, not a
    # code change:
    #
    #   local (Ollama):  DP_LLM_BASE_URL=http://localhost:11434/v1
    #                    DP_LLM_MODEL=<your local model tag>
    #                    DP_LLM_API_KEY=ollama          (ignored, must be non-empty)
    #
    #   demo (Groq):     DP_LLM_BASE_URL=https://api.groq.com/openai/v1
    #                    DP_LLM_MODEL=<a groq-hosted model>
    #                    DP_LLM_API_KEY=<real key>
    #
    # The key is read from the environment on the *server* and never leaves it.
    # It must never be placed in the extension bundle, which is world-readable
    # to anyone who installs it -- this is why explanations are a backend
    # endpoint rather than a direct call from the side panel.

    #: Master switch. When false, /v1/explain returns 503 with a clear reason
    #: instead of half-working -- the extension disables its own control on
    #: that signal rather than offering a button that always errors.
    llm_enabled: bool = False

    #: OpenAI-compatible base URL, including the version path segment.
    llm_base_url: str = "http://localhost:11434/v1"

    #: Model identifier as the provider names it. Defaulted to the local
    #: Ollama tag this was developed against; `ollama list` is the authority
    #: on what your install actually has.
    llm_model: str = "gemma4:31b-cloud"

    #: Sent as `Authorization: Bearer`. Ollama ignores the value but some
    #: clients require the header to be present at all.
    llm_api_key: str = "ollama"

    #: Per-request timeout in seconds. A local model on CPU is genuinely slow;
    #: this is deliberately generous, and the UI shows a pending state rather
    #: than blocking anything else.
    llm_timeout: float = 90.0

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
