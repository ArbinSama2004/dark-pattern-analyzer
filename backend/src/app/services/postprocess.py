"""Logits -> findings. The decision layer, isolated from onnxruntime on purpose.

This module holds every rule that turns raw model output into something a user
sees, and it imports nothing but numpy. That means the decision logic is unit
testable without the tokenizer, without onnxruntime and without the 951 MB graph
-- which matters, because the graph is gitignored and CI will never have it.

Three rules encoded here:

1. **Sigmoid, not softmax.** Multi-label: "Only 3 left - sale ends in 10:00" is
   scarcity AND false_urgency. 738 of 28,450 training rows carry >1 label.
2. **Per-class thresholds from the bundle.** Never 0.5 for everything. Flat 0.5
   scores macro-F1 0.8280; the tuned vector scores 0.9019.
3. **benign is not a decision input.** It is the 8th output and it is reported for
   transparency, but "benign" in the response means "no dark class cleared its
   threshold". Using the benign score as a veto would double-count it, since the
   model already trades it off against the other seven.
"""

from __future__ import annotations

import numpy as np


def sigmoid(logits: np.ndarray) -> np.ndarray:
    """Numerically stable elementwise sigmoid.

    The naive ``1 / (1 + exp(-x))`` overflows for large negative logits and the
    model does emit those for confidently-negative classes.
    """
    x = np.asarray(logits, dtype=np.float64)
    out = np.empty_like(x)
    positive = x >= 0
    out[positive] = 1.0 / (1.0 + np.exp(-x[positive]))
    exp_x = np.exp(x[~positive])
    out[~positive] = exp_x / (1.0 + exp_x)
    return out


def decide(
    probs: np.ndarray,
    *,
    labels: tuple[str, ...],
    thresholds: list[float],
    benign_label: str = "benign",
) -> list[dict[str, object]]:
    """Turn a (batch, num_labels) probability matrix into per-row decisions.

    Returns one dict per row with keys ``findings`` (list of label/score/threshold,
    sorted by descending score, benign excluded), ``benign`` (bool),
    ``benign_score`` (float) and ``scores`` (label -> float, all classes).

    The caller decides whether to expose ``scores``; it is always computed because
    it is nearly free and it is what makes a false positive debuggable later.
    """
    probs = np.asarray(probs, dtype=np.float64)
    if probs.ndim != 2:
        raise ValueError(f"expected a 2-D (batch, num_labels) array, got shape {probs.shape}")
    if probs.shape[1] != len(labels):
        raise ValueError(
            f"model emitted {probs.shape[1]} classes but the label contract has "
            f"{len(labels)}. This is label-axis drift -- do not serve these scores."
        )
    if len(thresholds) != len(labels):
        raise ValueError(
            f"got {len(thresholds)} thresholds for {len(labels)} labels; "
            "thresholds must be aligned to the frozen label order"
        )

    threshold_vector = np.asarray(thresholds, dtype=np.float64)
    over = probs >= threshold_vector
    benign_index = labels.index(benign_label)

    results: list[dict[str, object]] = []
    for row_index in range(probs.shape[0]):
        row = probs[row_index]
        findings: list[dict[str, object]] = []
        for label_index, label in enumerate(labels):
            if label_index == benign_index:
                continue
            if over[row_index, label_index]:
                findings.append(
                    {
                        "label": label,
                        "score": round(float(row[label_index]), 6),
                        "threshold": float(threshold_vector[label_index]),
                    }
                )
        findings.sort(key=lambda f: float(f["score"]), reverse=True)
        results.append(
            {
                "findings": findings,
                "benign": not findings,
                "benign_score": round(float(row[benign_index]), 6),
                "scores": {label: round(float(row[i]), 6) for i, label in enumerate(labels)},
            }
        )
    return results


__all__ = ["decide", "sigmoid"]
