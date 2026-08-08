"""Tune one decision threshold per class on the validation split.

    uv run python -m ml.tune_thresholds --artifacts ../ml/artifacts/model_v1

Why per-class thresholds
------------------------
A flat 0.5 cutoff assumes every class is equally easy and equally frequent.
Neither holds. ``obstruction`` phrasings are diffuse and the model is
under-confident on them; ``scarcity`` phrasings are formulaic and it is
over-confident. One global threshold either floods you with obstruction false
negatives or scarcity false positives.

Sweeping per class typically buys 3-6 macro-F1 points for zero training cost.
This is the highest return-per-effort step in the whole pipeline.

Three profiles are emitted:

``precision``  Maximises F1 subject to precision >= 0.80. **Default for the
               extension.** A false positive -- telling a user an honest site is
               manipulating them -- costs far more trust than a miss.
``balanced``   Maximises F1 outright. Use for reported research metrics.
``recall``     Maximises F1 subject to recall >= 0.80. Use for annotation
               assistance, where a human filters the output anyway.

Always tune on **validation**. Tuning on test invalidates your test numbers.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from sklearn.metrics import f1_score, precision_score, recall_score

from ml.config import LABELS, SPLIT_PRIMARY, TrainConfig
from ml.dataset import labels_matrix, load_split
from ml.metrics import sigmoid

GRID = np.arange(0.05, 0.96, 0.01)


def predict_logits(artifacts: Path, texts: list[str], cfg: TrainConfig) -> np.ndarray:
    """Run the saved PyTorch model over texts and return raw logits."""
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(str(artifacts / "tokenizer"))
    model = AutoModelForSequenceClassification.from_pretrained(str(artifacts / "pytorch"))
    model.eval()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)

    out = []
    bs = 64
    with torch.no_grad():
        for i in range(0, len(texts), bs):
            batch = tok(
                texts[i : i + bs],
                truncation=True,
                max_length=cfg.max_length,
                padding=True,
                return_tensors="pt",
            ).to(device)
            out.append(model(**batch).logits.cpu().numpy())
    return np.vstack(out)


def sweep_class(
    y_true: np.ndarray,
    prob: np.ndarray,
    min_precision: float | None = None,
    min_recall: float | None = None,
) -> tuple[float, dict[str, float]]:
    """Find the threshold maximising F1 under an optional constraint."""
    best_thr, best_f1, best_stats = 0.5, -1.0, {}
    fallback_thr, fallback_f1, fallback_stats = 0.5, -1.0, {}

    for thr in GRID:
        pred = (prob >= thr).astype(int)
        f1 = f1_score(y_true, pred, zero_division=0)
        p = precision_score(y_true, pred, zero_division=0)
        r = recall_score(y_true, pred, zero_division=0)
        stats = {"f1": float(f1), "precision": float(p), "recall": float(r)}

        if f1 > fallback_f1:
            fallback_thr, fallback_f1, fallback_stats = float(thr), f1, stats

        if min_precision is not None and p < min_precision:
            continue
        if min_recall is not None and r < min_recall:
            continue
        if f1 > best_f1:
            best_thr, best_f1, best_stats = float(thr), f1, stats

    # If the constraint was unsatisfiable anywhere on the grid, fall back to
    # unconstrained best rather than silently returning 0.5.
    if best_f1 < 0:
        return fallback_thr, {**fallback_stats, "constraint_unmet": True}
    return best_thr, best_stats


def tune(artifacts: Path, data_root: str) -> dict:
    cfg = TrainConfig()
    val = load_split(data_root, SPLIT_PRIMARY, "val")
    y = labels_matrix(val).astype(int)

    print(f"Scoring {len(val):,} validation rows ...")
    probs = sigmoid(predict_logits(artifacts, val[cfg.text_column].tolist(), cfg))

    profiles = {
        "precision": {"min_precision": 0.80},
        "balanced": {},
        "recall": {"min_recall": 0.80},
    }

    result: dict[str, dict] = {}
    for name, constraint in profiles.items():
        thresholds: dict[str, float] = {}
        detail: dict[str, dict[str, float]] = {}
        for i, lab in enumerate(LABELS):
            thr, stats = sweep_class(y[:, i], probs[:, i], **constraint)
            thresholds[lab] = round(thr, 3)
            detail[lab] = stats
        result[name] = {"thresholds": thresholds, "val_per_class": detail}

        print(f"\n--- profile: {name}")
        print(f"{'label':<17}{'thr':>7}{'prec':>8}{'rec':>8}{'f1':>8}")
        for lab in LABELS:
            d = detail[lab]
            flag = "  (constraint unmet)" if d.get("constraint_unmet") else ""
            print(
                f"{lab:<17}{thresholds[lab]:>7.2f}{d['precision']:>8.3f}"
                f"{d['recall']:>8.3f}{d['f1']:>8.3f}{flag}"
            )

    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Tune per-class decision thresholds")
    ap.add_argument("--artifacts", default="../ml/artifacts/model_v1")
    ap.add_argument("--data", default="../data/synthetic")
    args = ap.parse_args()

    artifacts = Path(args.artifacts)
    if not (artifacts / "pytorch").exists():
        raise SystemExit(f"No trained model at {artifacts / 'pytorch'}. Run ml.train first.")

    result = tune(artifacts, args.data)

    dest = artifacts / "thresholds.json"
    dest.write_text(
        json.dumps(
            {
                "default_profile": "precision",
                "tuned_on": f"{SPLIT_PRIMARY}/val",
                "profiles": result,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nWritten to {dest}")
    print("The backend loads this file at startup. Never hardcode thresholds.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
