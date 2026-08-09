"""Artifact bundle loader. The only interface between ml/ and backend/.

Everything contract-critical is read from disk here and verified once, at
startup. Invariants enforced in this file:

#1  label order comes from ``label_map.json`` and must equal the frozen tuple
#3  thresholds come from ``thresholds.json``; there is no hardcoded fallback
#4  ``model_version`` is cross-checked against the manifest so cache keys cannot
    silently describe a different model than the one loaded

If any check fails the process must refuse to start. A service that boots with a
mismatched bundle looks healthy while being wrong, which is the worst outcome.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from app.core.taxonomy import BENIGN_LABEL, EXPECTED_LABELS, verify_label_order

log = logging.getLogger(__name__)

#: Below this, ``model.onnx`` is almost certainly a dynamo pointer file whose
#: weights went to an external ``.data`` sidecar. Stage 1's exporter inlines
#: weights and asserts the same floor; re-asserting here catches a bundle that
#: was copied without its sidecar. See docs/RESULTS.md section 4.
MIN_ONNX_BYTES = 50 * 1024 * 1024


class BundleError(RuntimeError):
    """Raised when the artifact bundle is missing, incomplete or inconsistent."""


@dataclass(frozen=True)
class Bundle:
    """A verified Stage 1 artifact bundle."""

    root: Path
    onnx_path: Path
    tokenizer_path: Path

    #: Frozen label order, as loaded from label_map.json.
    labels: tuple[str, ...]

    #: Per-class decision thresholds for the active profile, label -> threshold.
    thresholds: dict[str, float]

    #: The active profile name.
    profile: str

    model_version: str
    base_model: str
    max_length: int
    dataset: str
    quantization: str

    #: ONNX graph input names, in the order the graph declares them.
    onnx_input_names: tuple[str, ...]

    @property
    def benign_index(self) -> int:
        return self.labels.index(BENIGN_LABEL)

    def threshold_vector(self) -> list[float]:
        """Thresholds as a list aligned to ``labels`` index order."""
        return [self.thresholds[lab] for lab in self.labels]

    def describe(self) -> dict[str, object]:
        """Small, log- and health-check-friendly summary."""
        return {
            "model_version": self.model_version,
            "base_model": self.base_model,
            "dataset": self.dataset,
            "quantization": self.quantization,
            "max_length": self.max_length,
            "threshold_profile": self.profile,
            "labels": list(self.labels),
        }


def _read_json(path: Path) -> dict:
    if not path.is_file():
        raise BundleError(f"missing bundle file: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BundleError(f"{path} is not valid JSON: {exc}") from exc


def _load_thresholds(path: Path, profile: str, labels: tuple[str, ...]) -> dict[str, float]:
    """Load the per-class thresholds for ``profile``. Invariant #3.

    No defaults, no partial fills. A missing class is a hard error: falling back
    to 0.5 for one class would quietly undo threshold tuning, which is worth
    +0.0739 macro-F1 and is the single largest win in Stage 1.
    """
    doc = _read_json(path)
    profiles = doc.get("profiles")
    if not isinstance(profiles, dict):
        raise BundleError(f"{path} has no 'profiles' object")
    if profile not in profiles:
        raise BundleError(
            f"threshold profile {profile!r} not in {path} (available: {sorted(profiles)})"
        )

    entry = profiles[profile]
    raw = entry.get("thresholds") if isinstance(entry, dict) else None
    if not isinstance(raw, dict):
        raise BundleError(f"profile {profile!r} in {path} has no 'thresholds' object")

    missing = [lab for lab in labels if lab not in raw]
    if missing:
        raise BundleError(
            f"profile {profile!r} in {path} is missing thresholds for {missing}. "
            "Refusing to guess -- re-run tune_thresholds."
        )

    thresholds: dict[str, float] = {}
    for lab in labels:
        value = raw[lab]
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise BundleError(f"threshold for {lab!r} in {path} is not a number: {value!r}")
        if not 0.0 < float(value) < 1.0:
            raise BundleError(f"threshold for {lab!r} out of range (0,1): {value!r}")
        thresholds[lab] = float(value)

    # Surface, but do not block on, the two known quality caveats recorded during
    # tuning. An operator switching profiles deserves to see them in the log.
    per_class = entry.get("val_per_class", {})
    if isinstance(per_class, dict):
        for lab, stats in per_class.items():
            if not isinstance(stats, dict):
                continue
            if stats.get("constraint_unmet"):
                log.warning(
                    "threshold profile %s: %s did not meet its validation precision "
                    "constraint (precision=%.3f). Known and accepted; see docs/RESULTS.md.",
                    profile,
                    lab,
                    float(stats.get("precision", float("nan"))),
                )
            precision = stats.get("precision")
            if isinstance(precision, (int, float)) and precision < 0.5:
                log.warning(
                    "threshold profile %s: %s has validation precision %.3f. "
                    "This profile will produce frequent false positives for that class.",
                    profile,
                    lab,
                    float(precision),
                )

    return thresholds


def load_bundle(
    model_dir: Path,
    *,
    profile: str,
    expected_version: str,
    require_onnx: bool = True,
) -> Bundle:
    """Load and verify the bundle at ``model_dir``.

    ``require_onnx=False`` is for tests and for contract checks in CI, where the
    951 MB graph is not present (it is gitignored). It never applies in serving:
    ``main.py`` always requires the graph.
    """
    root = model_dir.expanduser().resolve()
    if not root.is_dir():
        raise BundleError(
            f"artifact bundle directory not found: {root}\n"
            "Stage 1 must be complete. Set DP_MODEL_DIR to ml/artifacts/model_v1."
        )

    label_doc = _read_json(root / "label_map.json")
    labels_raw = label_doc.get("labels")
    if not isinstance(labels_raw, list) or not all(isinstance(x, str) for x in labels_raw):
        raise BundleError(f"{root / 'label_map.json'} has no valid 'labels' list")
    verify_label_order(labels_raw)
    labels = tuple(labels_raw)

    # label_to_id must agree with the list order too -- they are written together
    # but a hand-edit could desync them.
    label_to_id = label_doc.get("label_to_id")
    if isinstance(label_to_id, dict):
        for index, lab in enumerate(labels):
            if label_to_id.get(lab) != index:
                raise BundleError(
                    f"label_map.json inconsistent: label_to_id[{lab!r}]="
                    f"{label_to_id.get(lab)!r} but list index is {index}"
                )

    manifest = _read_json(root / "manifest.json")
    bundle_version = str(manifest.get("model_version", ""))
    if not bundle_version:
        raise BundleError(f"{root / 'manifest.json'} has no 'model_version'")
    if bundle_version != expected_version:
        raise BundleError(
            "model version mismatch. DP_MODEL_VERSION is baked into every cache key, "
            "so this must not be papered over.\n"
            f"  DP_MODEL_VERSION: {expected_version}\n"
            f"  manifest.json:    {bundle_version}"
        )

    max_length = manifest.get("max_length")
    if not isinstance(max_length, int) or max_length <= 0:
        raise BundleError(f"manifest.json has an invalid 'max_length': {max_length!r}")

    text_column = manifest.get("text_column")
    if text_column != "model_input":
        raise BundleError(
            f"manifest.json text_column is {text_column!r}, expected 'model_input'. "
            "This service always sends the [TAG=..] [ROLE=..] prefixed string."
        )

    thresholds = _load_thresholds(root / "thresholds.json", profile, labels)

    tokenizer_path = root / "tokenizer" / "tokenizer.json"
    if not tokenizer_path.is_file():
        raise BundleError(f"missing tokenizer: {tokenizer_path}")

    onnx_path = root / "model.onnx"
    if require_onnx:
        if not onnx_path.is_file():
            raise BundleError(
                f"missing ONNX graph: {onnx_path}\n"
                "It is gitignored by design (~951 MB). Copy it from the Stage 1 "
                "Colab run output into the bundle directory."
            )
        size = onnx_path.stat().st_size
        if size < MIN_ONNX_BYTES:
            raise BundleError(
                f"{onnx_path} is only {size / 1e6:.2f} MB. The fp32 graph is ~951 MB. "
                "A file this small is a dynamo pointer whose weights live in an "
                "external .data sidecar -- it will load but produce wrong output. "
                "Re-export with weights inlined."
            )

    inputs_file = root / "onnx_inputs.json"
    if inputs_file.is_file():
        names = json.loads(inputs_file.read_text(encoding="utf-8"))
        if not isinstance(names, list) or not all(isinstance(x, str) for x in names):
            raise BundleError(f"{inputs_file} is not a list of strings")
        onnx_input_names = tuple(names)
    else:
        onnx_input_names = ("input_ids", "attention_mask", "token_type_ids")

    return Bundle(
        root=root,
        onnx_path=onnx_path,
        tokenizer_path=tokenizer_path,
        labels=labels,
        thresholds=thresholds,
        profile=profile,
        model_version=bundle_version,
        base_model=str(manifest.get("base_model", "unknown")),
        max_length=max_length,
        dataset=str(manifest.get("dataset", "unknown")),
        quantization=str(manifest.get("quantization", "fp32")),
        onnx_input_names=onnx_input_names,
    )


__all__ = ["Bundle", "BundleError", "EXPECTED_LABELS", "load_bundle"]
