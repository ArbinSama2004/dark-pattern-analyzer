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
