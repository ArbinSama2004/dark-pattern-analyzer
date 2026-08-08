"""TF-IDF character n-gram + one-vs-rest logistic regression baseline.

    uv run python -m ml.baseline --data ../data/synthetic

Why bother with a baseline
--------------------------
Without it, a fine-tuned transformer scoring 0.88 macro-F1 is an uninterpretable
number. If this baseline scores 0.86, the transformer contributed almost
nothing and you should say so. If the baseline scores 0.61, you have evidence
that contextual embeddings genuinely matter for this task.

Either result is publishable. Not knowing is not.

Character n-grams (2-5) rather than word n-grams, deliberately: they are
script-agnostic, so the same feature extractor works across English, Hindi and
Nepali without per-language tokenization. For Devanagari this is a surprisingly
strong baseline.

Expected: roughly 0.70-0.80 macro-F1 on the template-disjoint split. Templated
text has strong lexical regularities, so do not be surprised by a high number --
that is a property of the synthetic data, and precisely why Stage 4's real gold
set is non-negotiable.
"""

from __future__ import annotations

import argparse
import json
import pickle
from pathlib import Path

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.pipeline import Pipeline

from ml.config import LABELS, SPLIT_LEAKY, SPLIT_PRIMARY, TrainConfig
from ml.dataset import labels_matrix, load_all_parts
from ml.metrics import format_table, per_class_report, per_language, summary


def build_pipeline(seed: int = 13) -> Pipeline:
    return Pipeline(
        [
            (
                "tfidf",
                TfidfVectorizer(
                    analyzer="char_wb",  # script-agnostic: works for Devanagari
                    ngram_range=(2, 5),
                    min_df=2,
                    max_features=200_000,
                    sublinear_tf=True,
                    lowercase=False,  # casing is a signal: "HURRY!" vs "hurry"
                ),
            ),
            (
                "clf",
                OneVsRestClassifier(
                    LogisticRegression(
                        max_iter=2000,
                        C=4.0,
                        class_weight="balanced",
                        random_state=seed,
                    ),
                    n_jobs=-1,
                ),
            ),
        ]
    )


def run_split(data_root: str, split: str, cfg: TrainConfig) -> dict:
    print(f"\n{'=' * 68}\nSplit: {split}\n{'=' * 68}")
    parts = load_all_parts(data_root, split)

    x_train = parts["train"][cfg.text_column].tolist()
    y_train = labels_matrix(parts["train"]).astype(int)
    x_test = parts["test"][cfg.text_column].tolist()
    y_test = labels_matrix(parts["test"]).astype(int)

    print(f"Fitting on {len(x_train):,} rows ...")
    pipe = build_pipeline(cfg.seed)
    pipe.fit(x_train, y_train)

    probs = pipe.predict_proba(x_test)
    preds = (probs >= 0.5).astype(int)

    s = summary(y_test, preds, probs)
    pc = per_class_report(y_test, preds, probs)
    pl = per_language(y_test, preds, parts["test"]["lang"].to_numpy())

    print(f"\nmacro_f1_dark : {s['macro_f1_dark']:.4f}   <-- headline")
    print(f"micro_f1      : {s['micro_f1']:.4f}")
    print(f"exact_match   : {s['exact_match']:.4f}")
    print("\n" + format_table(pc))
    print("\nPer language:")
    for lang, m in pl.items():
        print(f"  {lang}: n={m['n']:<6,} macro_f1_dark={m['macro_f1_dark']:.4f}")

    return {"split": split, "summary": s, "per_class": pc, "per_language": pl, "pipeline": pipe}


def main() -> int:
    ap = argparse.ArgumentParser(description="Train the baseline classifier")
    ap.add_argument("--data", default="../data/synthetic")
    ap.add_argument("--out", default="reports")
    ap.add_argument("--save-model", action="store_true", help="pickle the fitted pipeline")
    ap.add_argument(
        "--both-splits",
        action="store_true",
        help="also run the leaky random split to quantify the leakage gap",
    )
    args = ap.parse_args()

    cfg = TrainConfig()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    results = {}
    primary = run_split(args.data, SPLIT_PRIMARY, cfg)
    results[SPLIT_PRIMARY] = {k: v for k, v in primary.items() if k != "pipeline"}

    if args.both_splits:
        leaky = run_split(args.data, SPLIT_LEAKY, cfg)
        results[SPLIT_LEAKY] = {k: v for k, v in leaky.items() if k != "pipeline"}
        gap = (
            leaky["summary"]["macro_f1_dark"] - primary["summary"]["macro_f1_dark"]
        )
        results["leakage_gap_macro_f1_dark"] = gap
        print(f"\n{'=' * 68}")
        print(f"LEAKAGE GAP: random split scores {gap:+.4f} macro-F1 above template-disjoint.")
        print("That gap is memorisation of template skeletons, not learning.")
        print("Report the template-disjoint number only.")
        print("=" * 68)

    (out / "baseline_metrics.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    if args.save_model:
        with (out / "baseline_pipeline.pkl").open("wb") as fh:
            pickle.dump(primary["pipeline"], fh)
        print(f"Saved {out}/baseline_pipeline.pkl")

    print(f"\nWritten to {out}/baseline_metrics.json")
    print("\nThis number is the floor. The transformer must clear it on the")
    print("template-disjoint split, or it is not earning its complexity.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


# Silence an unused-import warning when only some helpers are used above.
_ = (LABELS, np)
