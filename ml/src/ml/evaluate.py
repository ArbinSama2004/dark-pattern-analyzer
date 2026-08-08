"""Final evaluation: macro-F1, per class, per language, plus error analysis.

    uv run python -m ml.evaluate --artifacts ../ml/artifacts/model_v1

Produces ``metrics.json`` in the artifacts directory -- the file that gets
committed and quoted in your report.

What this reports, and why
--------------------------
* **Template-disjoint test, tuned per-class thresholds.** The headline.
* **Per language.** Non-negotiable. An aggregate 0.88 can conceal English 0.94
  and Nepali 0.71, and the Nepali figure is the interesting one.
* **The leakage gap**, if ``--both-splits`` is passed. Reporting that the random
  split scores ~15 points higher, and explaining why, is a strength. Quietly
  reporting the random number is misconduct.
* **Confusion pairs.** Which classes get mistaken for which. Expect
  scarcity/false_urgency confusion -- they genuinely co-occur -- and
  confirmshaming/obstruction confusion, since both live on decline buttons.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

from ml.config import LABELS, SPLIT_LEAKY, SPLIT_PRIMARY, TrainConfig
from ml.dataset import labels_matrix, load_split
from ml.metrics import (
    apply_thresholds,
    format_table,
    per_class_report,
    per_language,
    sigmoid,
    summary,
)
from ml.tune_thresholds import predict_logits


def load_thresholds(artifacts: Path, profile: str) -> dict[str, float]:
    path = artifacts / "thresholds.json"
    if not path.exists():
        print(f"WARNING: {path} missing; falling back to a flat 0.5 cutoff.")
        print("         Run ml.tune_thresholds for 3-6 extra macro-F1 points.")
        return dict.fromkeys(LABELS, 0.5)
    blob = json.loads(path.read_text(encoding="utf-8"))
    return blob["profiles"][profile]["thresholds"]


def confusion_pairs(y_true: np.ndarray, y_pred: np.ndarray, top: int = 12) -> list[dict]:
    """Count (true label, wrongly predicted label) pairs."""
    counter: Counter[tuple[str, str]] = Counter()
    for i in range(len(y_true)):
        truth = {LABELS[j] for j in range(len(LABELS)) if y_true[i, j]}
        pred = {LABELS[j] for j in range(len(LABELS)) if y_pred[i, j]}
        for missed in truth - pred:
            for spurious in pred - truth:
                counter[(missed, spurious)] += 1
    return [
        {"true": a, "predicted_instead": b, "count": n} for (a, b), n in counter.most_common(top)
    ]


def error_examples(
    df: pd.DataFrame,
    y_true: np.ndarray,
    y_pred: np.ndarray,
    n: int = 20,
) -> dict[str, list[dict]]:
    """Sample false positives and false negatives for manual inspection.

    Read these. Aggregate metrics tell you how well the model does; these tell
    you what it misunderstands, which is what you actually write about.
    """
    fps, fns = [], []
    for i in range(len(df)):
        truth = {LABELS[j] for j in range(len(LABELS)) if y_true[i, j]}
        pred = {LABELS[j] for j in range(len(LABELS)) if y_pred[i, j]}
        row = {
            "text": df.iloc[i]["text"],
            "lang": df.iloc[i]["lang"],
            "true": sorted(truth),
            "pred": sorted(pred),
        }
        if pred - truth and len(fps) < n:
            fps.append(row)
        if truth - pred and len(fns) < n:
            fns.append(row)
        if len(fps) >= n and len(fns) >= n:
            break
    return {"false_positives": fps, "false_negatives": fns}


def evaluate_split(
    artifacts: Path,
    data_root: str,
    split: str,
    profile: str,
    cfg: TrainConfig,
) -> dict:
    print(f"\n{'=' * 68}\n{split} / test  (profile: {profile})\n{'=' * 68}")
    df = load_split(data_root, split, "test")
    y = labels_matrix(df).astype(int)
    probs = sigmoid(predict_logits(artifacts, df[cfg.text_column].tolist(), cfg))

    thresholds = load_thresholds(artifacts, profile)
    preds = apply_thresholds(probs, thresholds)

    s = summary(y, preds, probs)
    pc = per_class_report(y, preds, probs)
    pl = per_language(y, preds, df["lang"].to_numpy())

    print(f"\nmacro_f1_dark : {s['macro_f1_dark']:.4f}   <-- HEADLINE")
    print(f"micro_f1      : {s['micro_f1']:.4f}")
    print(f"exact_match   : {s['exact_match']:.4f}")
    print("\n" + format_table(pc))

    print("\nPer language:")
    for lang, m in pl.items():
        print(f"  {lang}: n={m['n']:<6,} macro_f1_dark={m['macro_f1_dark']:.4f}")

    if len(pl) > 1:
        vals = {k: v["macro_f1_dark"] for k, v in pl.items()}
        spread = max(vals.values()) - min(vals.values())
        print(f"  spread: {spread:.4f}")
        if spread > 0.10:
            worst = min(vals, key=vals.get)
            print(
                f"  NOTE: {worst} lags by more than 0.10. Check tokenizer fertility;\n"
                f"        consider MuRIL as the base model."
            )

    cm = confusion_pairs(y, preds)
    print("\nTop confusions (true -> predicted instead):")
    for c in cm[:8]:
        print(f"  {c['true']:<16} -> {c['predicted_instead']:<16} {c['count']:>5}")

    return {
        "split": split,
        "profile": profile,
        "thresholds": thresholds,
        "summary": s,
        "per_class": pc,
        "per_language": pl,
        "confusions": cm,
        "errors": error_examples(df, y, preds),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Evaluate the fine-tuned model")
    ap.add_argument("--artifacts", default="../ml/artifacts/model_v1")
    ap.add_argument("--data", default="../data/synthetic")
    ap.add_argument("--profile", default="precision", choices=["precision", "balanced", "recall"])
    ap.add_argument("--both-splits", action="store_true", help="also run the leaky split")
    args = ap.parse_args()

    artifacts = Path(args.artifacts)
    cfg = TrainConfig()

    results = {"primary": evaluate_split(artifacts, args.data, SPLIT_PRIMARY, args.profile, cfg)}

    if args.both_splits:
        leaky = evaluate_split(artifacts, args.data, SPLIT_LEAKY, args.profile, cfg)
        results["leaky_reference"] = leaky
        gap = leaky["summary"]["macro_f1_dark"] - results["primary"]["summary"]["macro_f1_dark"]
        results["leakage_gap_macro_f1_dark"] = gap
        print(f"\n{'=' * 68}")
        print(f"LEAKAGE GAP: {gap:+.4f} macro-F1")
        print("The random split shares template skeletons across train and test, so")
        print("the model can score highly by memorisation. Report the")
        print("template-disjoint number, and cite this gap as evidence of rigour.")
        print("=" * 68)

    dest = artifacts / "metrics.json"
    dest.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nWritten to {dest}")

    print("\nReminder: these are SYNTHETIC test numbers. They show the pipeline")
    print("works. They are not evidence the tool works on real websites -- that is")
    print("Stage 4's gold set, where a drop to 0.65-0.75 is expected and normal.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
