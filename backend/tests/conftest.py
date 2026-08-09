"""Test fixtures.

Design note: the 951 MB ONNX graph is gitignored, so CI will never have it. Every
test here therefore runs against either a synthetic bundle directory or the real
bundle's small evidence files (label_map.json, thresholds.json, manifest.json),
which *are* committed. Tests that genuinely need the graph are skipped rather than
faked, and are marked ``needs_model``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_BUNDLE = REPO_ROOT / "ml" / "artifacts" / "model_v1"
ML_CONFIG = REPO_ROOT / "ml" / "src" / "ml" / "config.py"

LABELS = [
    "confirmshaming",
    "false_urgency",
    "forced_action",
    "obstruction",
    "scarcity",
    "sneaking",
    "social_proof",
    "benign",
]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "needs_model: requires the ~951 MB model.onnx")


@pytest.fixture
def real_bundle_dir() -> Path:
    """The committed evidence files of the real bundle, skipping if absent."""
    if not (REAL_BUNDLE / "label_map.json").is_file():
        pytest.skip(f"real bundle evidence files not present at {REAL_BUNDLE}")
    return REAL_BUNDLE


@pytest.fixture
def ml_config_path() -> Path:
    """Path to ml/src/ml/config.py, skipping if the ml/ tree is absent."""
    if not ML_CONFIG.is_file():
        pytest.skip(f"ml config not present at {ML_CONFIG}")
    return ML_CONFIG


def write_bundle(
    root: Path,
    *,
    labels: list[str] | None = None,
    model_version: str = "1.0.0",
    thresholds: dict[str, float] | None = None,
    max_length: int = 64,
    text_column: str = "model_input",
    with_tokenizer: bool = True,
) -> Path:
    """Write a minimal, valid-by-default bundle so tests can perturb one field."""
    labels = labels if labels is not None else list(LABELS)
    thresholds = thresholds if thresholds is not None else dict.fromkeys(labels, 0.5)

    root.mkdir(parents=True, exist_ok=True)
    (root / "label_map.json").write_text(
        json.dumps(
            {"labels": labels, "label_to_id": {lab: i for i, lab in enumerate(labels)}},
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "model_version": model_version,
                "base_model": "google/muril-base-cased",
                "max_length": max_length,
                "text_column": text_column,
                "quantized": False,
                "dataset": "synthetic_v2_1",
                "quantization": "fp32",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    (root / "thresholds.json").write_text(
        json.dumps(
            {
                "default_profile": "precision",
                "tuned_on": "split_template_disjoint/val",
                "profiles": {"precision": {"thresholds": thresholds}},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    if with_tokenizer:
        (root / "tokenizer").mkdir(exist_ok=True)
        (root / "tokenizer" / "tokenizer.json").write_text("{}", encoding="utf-8")
    return root


@pytest.fixture
def bundle_dir(tmp_path: Path) -> Path:
    return write_bundle(tmp_path / "model_v1")
