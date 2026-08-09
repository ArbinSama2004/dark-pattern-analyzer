"""The decision layer: sigmoid, per-class thresholds, multi-label, benign.

These tests need neither onnxruntime nor the 951 MB graph, which is the reason
``postprocess`` is a separate module. They pin the three rules that turn raw
logits into something a user sees.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.core.taxonomy import EXPECTED_LABELS
from app.services.postprocess import decide, sigmoid

# The real tuned vector, in frozen label order.
TUNED = [0.11, 0.58, 0.43, 0.54, 0.62, 0.48, 0.46, 0.17]
IDX = {label: i for i, label in enumerate(EXPECTED_LABELS)}


def _logit(p: float) -> float:
    return math.log(p / (1 - p))


def _row(**probs: float) -> np.ndarray:
    """Build a one-row logit matrix from desired probabilities per label."""
    row = [_logit(probs.get(label, 0.01)) for label in EXPECTED_LABELS]
    return np.asarray([row], dtype=np.float64)


# --- sigmoid ---------------------------------------------------------------


def test_sigmoid_matches_the_reference_formula() -> None:
    x = np.asarray([[-2.0, -0.5, 0.0, 0.5, 2.0]])
    expected = 1 / (1 + np.exp(-x))
    assert np.allclose(sigmoid(x), expected)


def test_sigmoid_is_stable_for_large_negative_logits() -> None:
    """Naive 1/(1+exp(-x)) overflows here; confidently-negative classes hit this."""
    out = sigmoid(np.asarray([[-800.0, 800.0]]))
    assert np.all(np.isfinite(out))
    assert out[0, 0] == pytest.approx(0.0)
    assert out[0, 1] == pytest.approx(1.0)


def test_sigmoid_zero_is_one_half() -> None:
    assert sigmoid(np.zeros((1, 1)))[0, 0] == pytest.approx(0.5)


# --- thresholds ------------------------------------------------------------


def test_per_class_thresholds_are_applied_not_a_flat_half() -> None:
    """scarcity 0.55 is over 0.5 but under its tuned 0.62, so it must not fire.

    Flat 0.5 scores macro-F1 0.8280; the tuned vector scores 0.9019. This test is
    what stops that +0.0739 from being silently given back.
    """
    probs = sigmoid(_row(scarcity=0.55))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert result["findings"] == []
    assert result["benign"] is True


def test_score_at_threshold_fires() -> None:
    probs = sigmoid(_row(scarcity=0.62))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert [f["label"] for f in result["findings"]] == ["scarcity"]


def test_confirmshaming_low_threshold_is_honoured() -> None:
    """confirmshaming tunes to 0.11 -- a flat 0.5 would suppress it entirely."""
    probs = sigmoid(_row(confirmshaming=0.20))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert [f["label"] for f in result["findings"]] == ["confirmshaming"]


def test_threshold_is_reported_with_each_finding() -> None:
    probs = sigmoid(_row(scarcity=0.9))
    finding = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]["findings"][0]
    assert finding["threshold"] == 0.62


# --- multi-label -----------------------------------------------------------


def test_multi_label_is_supported() -> None:
    """'Only 3 left - sale ends in 10:00' is scarcity AND false_urgency.

    738 of 28,450 training rows carry more than one label, so softmax would be
    wrong here by construction.
    """
    probs = sigmoid(_row(scarcity=0.88, false_urgency=0.71))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert {f["label"] for f in result["findings"]} == {"scarcity", "false_urgency"}
    assert result["benign"] is False


def test_findings_are_sorted_by_descending_score() -> None:
    probs = sigmoid(_row(scarcity=0.70, false_urgency=0.95, sneaking=0.80))
    labels = [f["label"] for f in decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]["findings"]]
    assert labels == ["false_urgency", "sneaking", "scarcity"]


def test_all_seven_dark_classes_can_fire_at_once() -> None:
    probs = sigmoid(_row(**{label: 0.99 for label in EXPECTED_LABELS if label != "benign"}))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert len(result["findings"]) == 7


# --- benign ----------------------------------------------------------------


def test_benign_is_never_reported_as_a_finding() -> None:
    probs = sigmoid(_row(benign=0.99))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert result["findings"] == []
    assert result["benign"] is True
    assert result["benign_score"] == pytest.approx(0.99, abs=1e-4)


def test_benign_score_does_not_veto_a_dark_finding() -> None:
    """benign is reported, not used as a decision input.

    Vetoing on it would double-count: the model already traded benign off against
    the other seven during training.
    """
    probs = sigmoid(_row(benign=0.95, scarcity=0.90))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert [f["label"] for f in result["findings"]] == ["scarcity"]
    assert result["benign"] is False


def test_benign_means_absence_of_a_detection() -> None:
    """Low scores everywhere, including benign, still yields benign=True."""
    probs = sigmoid(_row(benign=0.02))
    result = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]
    assert result["benign"] is True


# --- shape contracts -------------------------------------------------------


def test_all_scores_are_always_computed() -> None:
    probs = sigmoid(_row(scarcity=0.9))
    scores = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)[0]["scores"]
    assert set(scores) == set(EXPECTED_LABELS)


def test_batch_rows_are_independent() -> None:
    probs = np.concatenate([sigmoid(_row(scarcity=0.9)), sigmoid(_row(benign=0.9))], axis=0)
    results = decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED)
    assert len(results) == 2
    assert results[0]["benign"] is False
    assert results[1]["benign"] is True


def test_empty_batch_is_fine() -> None:
    probs = np.zeros((0, 8))
    assert decide(probs, labels=EXPECTED_LABELS, thresholds=TUNED) == []


def test_wrong_class_count_is_rejected() -> None:
    """Label-axis drift must raise, never be served."""
    with pytest.raises(ValueError, match="label-axis drift|classes"):
        decide(np.zeros((1, 7)), labels=EXPECTED_LABELS, thresholds=TUNED)


def test_misaligned_threshold_count_is_rejected() -> None:
    with pytest.raises(ValueError, match="thresholds"):
        decide(np.zeros((1, 8)), labels=EXPECTED_LABELS, thresholds=TUNED[:-1])


def test_one_dimensional_input_is_rejected() -> None:
    with pytest.raises(ValueError, match="2-D"):
        decide(np.zeros(8), labels=EXPECTED_LABELS, thresholds=TUNED)
