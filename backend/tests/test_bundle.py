"""Invariants #1, #3, #4 enforced at load time.

Every test here asserts that the service *refuses to start* on a bad bundle. That
is the whole design: a running service with a permuted label axis or a stale
model version looks perfectly healthy while being wrong, which is worse than a
service that will not boot.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.bundle import BundleError, load_bundle
from app.core.taxonomy import EXPECTED_LABELS, LabelContractError, verify_label_order
from tests.conftest import LABELS, write_bundle


def _load(root: Path, **kwargs):
    kwargs.setdefault("profile", "precision")
    kwargs.setdefault("expected_version", "1.0.0")
    kwargs.setdefault("require_onnx", False)
    return load_bundle(root, **kwargs)


# --- happy path ------------------------------------------------------------


def test_loads_a_valid_bundle(bundle_dir: Path) -> None:
    bundle = _load(bundle_dir)
    assert bundle.labels == EXPECTED_LABELS
    assert bundle.model_version == "1.0.0"
    assert bundle.max_length == 64
    assert len(bundle.threshold_vector()) == 8


def test_real_bundle_evidence_files_are_valid(real_bundle_dir: Path) -> None:
    """The committed Stage 1 evidence files must satisfy every contract check.

    This is the test that would have caught the stale-Colab-module incident, where
    metrics labelled v2.1 were actually produced on v2.
    """
    bundle = _load(real_bundle_dir)
    assert bundle.labels == EXPECTED_LABELS
    assert bundle.dataset == "synthetic_v2_1"
    assert bundle.quantization == "fp32"
    assert bundle.base_model == "google/muril-base-cased"
    assert bundle.onnx_input_names == ("input_ids", "attention_mask", "token_type_ids")


def test_real_bundle_thresholds_are_the_tuned_ones(real_bundle_dir: Path) -> None:
    """Guard the exact tuned vector. Flat 0.5 scores 0.8280; this scores 0.9019."""
    bundle = _load(real_bundle_dir)
    assert bundle.thresholds == {
        "confirmshaming": 0.11,
        "false_urgency": 0.58,
        "forced_action": 0.43,
        "obstruction": 0.54,
        "scarcity": 0.62,
        "sneaking": 0.48,
        "social_proof": 0.46,
        "benign": 0.17,
    }


def test_recall_profile_differs_only_in_social_proof(real_bundle_dir: Path) -> None:
    precision = _load(real_bundle_dir, profile="precision").thresholds
    recall = _load(real_bundle_dir, profile="recall").thresholds
    differing = {k for k in precision if precision[k] != recall[k]}
    assert differing == {"social_proof"}
    assert recall["social_proof"] == 0.08


# --- invariant #1: label order --------------------------------------------


def test_verify_label_order_accepts_the_frozen_order() -> None:
    verify_label_order(list(EXPECTED_LABELS))


def test_permuted_labels_are_rejected(tmp_path: Path) -> None:
    swapped = list(LABELS)
    swapped[4], swapped[5] = swapped[5], swapped[4]  # scarcity <-> sneaking
    root = write_bundle(tmp_path / "b", labels=swapped)
    with pytest.raises(LabelContractError, match="label order drift"):
        _load(root)


def test_missing_label_is_rejected(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", labels=LABELS[:-1])
    with pytest.raises(LabelContractError):
        _load(root)


def test_desynced_label_to_id_is_rejected(bundle_dir: Path) -> None:
    path = bundle_dir / "label_map.json"
    doc = json.loads(path.read_text())
    doc["label_to_id"]["scarcity"] = 5
    path.write_text(json.dumps(doc))
    with pytest.raises(BundleError, match="inconsistent"):
        _load(bundle_dir)


# --- invariant #3: thresholds from the bundle ------------------------------


def test_missing_threshold_is_never_defaulted(tmp_path: Path) -> None:
    partial = {lab: 0.5 for lab in LABELS if lab != "scarcity"}
    root = write_bundle(tmp_path / "b")
    doc = json.loads((root / "thresholds.json").read_text())
    doc["profiles"]["precision"]["thresholds"] = partial
    (root / "thresholds.json").write_text(json.dumps(doc))
    with pytest.raises(BundleError, match="missing thresholds"):
        _load(root)


def test_unknown_profile_is_rejected(bundle_dir: Path) -> None:
    with pytest.raises(BundleError, match="not in"):
        _load(bundle_dir, profile="balanced")


@pytest.mark.parametrize("bad", [0.0, 1.0, -0.2, 1.5])
def test_out_of_range_threshold_is_rejected(tmp_path: Path, bad: float) -> None:
    thresholds = dict.fromkeys(LABELS, 0.5)
    thresholds["scarcity"] = bad
    root = write_bundle(tmp_path / f"b{bad}", thresholds=thresholds)
    with pytest.raises(BundleError, match="out of range"):
        _load(root)


def test_non_numeric_threshold_is_rejected(tmp_path: Path) -> None:
    thresholds: dict[str, object] = dict.fromkeys(LABELS, 0.5)
    thresholds["scarcity"] = "0.62"
    root = write_bundle(tmp_path / "b", thresholds=thresholds)  # type: ignore[arg-type]
    with pytest.raises(BundleError, match="not a number"):
        _load(root)


# --- invariant #4: model version in every cache key -----------------------


def test_model_version_mismatch_is_fatal(bundle_dir: Path) -> None:
    with pytest.raises(BundleError, match="model version mismatch"):
        _load(bundle_dir, expected_version="1.1.0")


# --- structural checks ----------------------------------------------------


def test_missing_directory_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(BundleError, match="not found"):
        _load(tmp_path / "nope")


def test_missing_tokenizer_is_rejected(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", with_tokenizer=False)
    with pytest.raises(BundleError, match="missing tokenizer"):
        _load(root)


def test_wrong_text_column_is_rejected(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", text_column="text")
    with pytest.raises(BundleError, match="text_column"):
        _load(root)


def test_pointer_sized_onnx_is_rejected(bundle_dir: Path) -> None:
    """The 0.1 MB dynamo pointer file trap. It loads fine and is silently wrong."""
    (bundle_dir / "model.onnx").write_bytes(b"\x00" * 1024)
    with pytest.raises(BundleError, match="pointer"):
        _load(bundle_dir, require_onnx=True)


def test_absent_onnx_is_rejected_when_required(bundle_dir: Path) -> None:
    with pytest.raises(BundleError, match="missing ONNX graph"):
        _load(bundle_dir, require_onnx=True)


def test_malformed_json_is_rejected(bundle_dir: Path) -> None:
    (bundle_dir / "manifest.json").write_text("{not json")
    with pytest.raises(BundleError, match="not valid JSON"):
        _load(bundle_dir)
