"""Shared metric computation. Used by baseline, train, evaluate and the notebook.

One module so that every number reported anywhere in the project is computed the
same way. Duplicating metric code is how two sections of a report end up
disagreeing about the same model.
"""

from __future__ import annotations

import numpy as np
from sklearn.metrics import (
    average_precision_score,
    f1_score,
    precision_score,
    recall_score,
)

from ml.config import DARK_LABELS, LABELS


def sigmoid(x: np.ndarray) -> np.ndarray:
    """Numerically stable sigmoid."""
    return np.where(x >= 0, 1.0 / (1.0 + np.exp(-x)), np.exp(x) / (1.0 + np.exp(x)))


def apply_thresholds(probs: np.ndarray, thresholds: dict[str, float] | float) -> np.ndarray:
    """Binarize probabilities using per-class (or a single global) threshold."""
    if isinstance(thresholds, (int, float)):
        return (probs >= float(thresholds)).astype(int)
    thr = np.array([thresholds.get(lab, 0.5) for lab in LABELS], dtype=np.float32)
    return (probs >= thr).astype(int)


def per_class_report(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    probs: np.ndarray | None = None,
) -> dict[str, dict[str, float]]:
    """Precision, recall, F1, support and (optionally) average precision per class."""
    out: dict[str, dict[str, float]] = {}
    for i, lab in enumerate(LABELS):
        entry = {
            "precision": float(precision_score(y_true[:, i], y_pred[:, i], zero_division=0)),
            "recall": float(recall_score(y_true[:, i], y_pred[:, i], zero_division=0)),
            "f1": float(f1_score(y_true[:, i], y_pred[:, i], zero_division=0)),
            "support": int(y_true[:, i].sum()),
            "predicted": int(y_pred[:, i].sum()),
        }
        if probs is not None and y_true[:, i].sum() > 0:
            entry["avg_precision"] = float(average_precision_score(y_true[:, i], probs[:, i]))
        out[lab] = entry
    return out


def macro_f1_dark(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    """THE headline metric: macro-F1 over the seven manipulative classes.

    ``benign`` is excluded deliberately. It is the largest class and by far the
    easiest, so including it inflates the number and masks the failures that
    actually matter.
    """
    idx = [LABELS.index(lab) for lab in DARK_LABELS]
    return float(f1_score(y_true[:, idx], y_pred[:, idx], average="macro", zero_division=0))


def summary(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    probs: np.ndarray | None = None,
) -> dict[str, float]:
    """Headline metrics in one dict."""
    idx = [LABELS.index(lab) for lab in DARK_LABELS]
    return {
        "macro_f1_dark": macro_f1_dark(y_true, y_pred),
        "macro_f1_all": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "micro_f1": float(f1_score(y_true, y_pred, average="micro", zero_division=0)),
        "macro_precision_dark": float(
            precision_score(y_true[:, idx], y_pred[:, idx], average="macro", zero_division=0)
        ),
        "macro_recall_dark": float(
            recall_score(y_true[:, idx], y_pred[:, idx], average="macro", zero_division=0)
        ),
        "exact_match": float((y_true == y_pred).all(axis=1).mean()),
        "hamming_accuracy": float((y_true == y_pred).mean()),
    }


def per_language(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    langs: np.ndarray | list[str],
) -> dict[str, dict[str, float]]:
    """Break the headline metrics down by language.

    Always report this. An aggregate macro-F1 of 0.88 can hide English at 0.94
    and Nepali at 0.71, and the Nepali number is the interesting one.
    """
    langs = np.asarray(langs)
    out: dict[str, dict[str, float]] = {}
    for lang in sorted(set(langs.tolist())):
        m = langs == lang
        if m.sum() == 0:
            continue
        out[lang] = {
            "n": int(m.sum()),
            "macro_f1_dark": macro_f1_dark(y_true[m], y_pred[m]),
            "micro_f1": float(f1_score(y_true[m], y_pred[m], average="micro", zero_division=0)),
        }
    return out


def hf_compute_metrics(eval_pred) -> dict[str, float]:
    """``compute_metrics`` callback for the HuggingFace Trainer.

    Uses a flat 0.5 threshold. That is fine for model selection during
    training; real per-class thresholds are tuned afterwards on validation by
    ``tune_thresholds.py``.
    """
    logits, labels = eval_pred
    probs = sigmoid(np.asarray(logits))
    preds = (probs >= 0.5).astype(int)
    y = np.asarray(labels).astype(int)
    s = summary(y, preds, probs)
    return {
        "macro_f1_dark": s["macro_f1_dark"],
        "micro_f1": s["micro_f1"],
        "exact_match": s["exact_match"],
    }


def format_table(per_class: dict[str, dict[str, float]]) -> str:
    """Render a per-class report as a fixed-width table for logs and reports."""
    head = f"{'label':<17}{'prec':>7}{'rec':>7}{'f1':>7}{'supp':>8}{'pred':>8}"
    lines = [head, "-" * len(head)]
    for lab, m in per_class.items():
        marker = " " if lab in DARK_LABELS else "*"
        lines.append(
            f"{marker}{lab:<16}{m['precision']:>7.3f}{m['recall']:>7.3f}"
            f"{m['f1']:>7.3f}{m['support']:>8d}{m['predicted']:>8d}"
        )
    lines.append("-" * len(head))
    lines.append("* excluded from macro_f1_dark")
    return "\n".join(lines)
