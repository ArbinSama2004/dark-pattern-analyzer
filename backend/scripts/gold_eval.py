"""Score the model against the hand-annotated gold set.

    cd backend && uv run python scripts/gold_eval.py ../data/gold/gold.csv
    make gold-eval

This is the honest evaluation. Every other number in docs/RESULTS.md is measured
on synthetic data this project generated itself, which demonstrates the pipeline
works but not that the tool works on real websites.

The model is **re-run** over the gold texts rather than reusing the
`model_labels` column recorded at capture time. Those were produced by whatever
thresholds and bundle were live when the page was scanned; scoring against them
would silently measure a past configuration. The column is kept in the CSV for
the annotator's reference and is ignored here.

Also reports the **rule ablation** (`docs/STAGES.md` Stage 4 exit criteria):
macro-F1 with the rule layer merged in versus the model alone. Rules can only
add findings, never remove them, so the comparison shows exactly what structural
detection buys — expected to help recall and, where a rule fires on something the
model missed entirely, to be the only thing catching that class at all.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from app.core.bundle import BundleError, load_bundle  # noqa: E402
from app.core.model_input import build_model_input  # noqa: E402
from app.core.taxonomy import BENIGN_LABEL, DARK_LABELS  # noqa: E402
from app.services.inference import InferenceEngine  # noqa: E402
from app.services.postprocess import decide  # noqa: E402
from app.settings import get_settings  # noqa: E402

#: Which local rule implies which label. Mirrors the frontend's rule-to-label
#: mapping (frontend/src/lib/rules/). Duplicated rather than imported because
#: the rules themselves cannot run here -- they need live DOM, computed styles
#: and mutation cadence. Only the mapping is needed to model the merge.
RULE_LABELS: dict[str, str] = {
    "stock_counter": "scarcity",
    "countdown_timer": "false_urgency",
    "viewer_counter": "social_proof",
    "prechecked_optin": "sneaking",
    "hidden_optout": "obstruction",
    "cta_asymmetry": "confirmshaming",
    "late_fee": "sneaking",
    "cancel_offsite": "obstruction",
    "discount_badge": "false_urgency",
    "forced_action_gate": "forced_action",
}


def parse_labels(cell: str) -> set[str]:
    """A gold or predicted cell into a label set.

    `benign` is represented as the empty set, not as a member. It is the absence
    of any finding, and treating it as a label would put it into the macro
    average -- the same inflation docs/RESULTS.md excludes it from everywhere
    else.
    """
    labels = {tok.strip() for tok in cell.replace(",", " ").split() if tok.strip()}
    labels.discard(BENIGN_LABEL)
    return labels


def prf(tp: int, fp: int, fn: int) -> tuple[float, float, float]:
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return precision, recall, f1


def score(
    gold: list[set[str]], pred: list[set[str]], langs: list[str]
) -> tuple[dict[str, tuple[float, float, float, int]], float, dict[str, float]]:
    """Per-class P/R/F1 + support, macro-F1 over dark classes, and per-language F1."""
    per_class: dict[str, tuple[float, float, float, int]] = {}
    for label in DARK_LABELS:
        tp = sum(1 for g, p in zip(gold, pred) if label in g and label in p)
        fp = sum(1 for g, p in zip(gold, pred) if label not in g and label in p)
        fn = sum(1 for g, p in zip(gold, pred) if label in g and label not in p)
        precision, recall, f1 = prf(tp, fp, fn)
        per_class[label] = (precision, recall, f1, tp + fn)

    macro = sum(v[2] for v in per_class.values()) / len(DARK_LABELS)

    by_lang: dict[str, float] = {}
    for lang in sorted(set(langs)):
        idx = [i for i, ln in enumerate(langs) if ln == lang]
        f1s = []
        for label in DARK_LABELS:
            tp = sum(1 for i in idx if label in gold[i] and label in pred[i])
            fp = sum(1 for i in idx if label not in gold[i] and label in pred[i])
            fn = sum(1 for i in idx if label in gold[i] and label not in pred[i])
            f1s.append(prf(tp, fp, fn)[2])
        by_lang[lang] = sum(f1s) / len(DARK_LABELS)

    return per_class, macro, by_lang


def print_table(title: str, per_class, macro: float, by_lang: dict[str, float]) -> None:
    print(f"\n=== {title}")
    print(f"{'label':<17}{'prec':>8}{'rec':>8}{'f1':>8}{'support':>9}")
    print("-" * 50)
    for label in DARK_LABELS:
        p, r, f1, support = per_class[label]
        print(f"{label:<17}{p:>8.3f}{r:>8.3f}{f1:>8.3f}{support:>9}")
    print("-" * 50)
    print(f"{'macro-F1 (dark)':<17}{'':>8}{'':>8}{macro:>8.3f}")
    print()
    for lang, f1 in by_lang.items():
        print(f"  macro-F1, {lang:<4} {f1:.3f}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Evaluate the model against the gold set")
    ap.add_argument("gold_csv", type=Path)
    args = ap.parse_args()

    if not args.gold_csv.is_file():
        print(f"No such file: {args.gold_csv}", file=sys.stderr)
        return 1

    rows = [
        row
        for row in csv.DictReader(args.gold_csv.open(encoding="utf-8"))
        if (row.get("gold_labels") or "").strip()
    ]
    if not rows:
        print(
            "No annotated rows found -- every `gold_labels` cell is empty.\n"
            "Fill that column first; see docs/ANNOTATION.md.",
            file=sys.stderr,
        )
        return 1

    settings = get_settings()
    try:
        bundle = load_bundle(
            settings.model_dir,
            profile=settings.threshold_profile,
            expected_version=settings.model_version,
        )
    except BundleError as exc:
        print(f"Cannot load the bundle: {exc}", file=sys.stderr)
        return 1

    engine = InferenceEngine(bundle, max_batch=settings.max_batch)
    thresholds = [bundle.thresholds[label] for label in bundle.labels]

    texts = [
        build_model_input(
            text=row["text"], tag=row.get("tag", "span"), role=row.get("role", "none")
        )
        for row in rows
    ]
    probs, _ = engine.predict_probs(texts)
    decisions = decide(probs, labels=bundle.labels, thresholds=thresholds)

    gold = [parse_labels(row["gold_labels"]) for row in rows]
    langs = [row.get("lang", "?") for row in rows]

    model_only = [{f["label"] for f in d["findings"]} for d in decisions]

    # The merge the extension actually applies: a fired rule contributes its
    # label whether or not the model agreed (frontend/src/lib/merge.ts).
    merged = []
    for row, predicted in zip(rows, model_only):
        labels = set(predicted)
        for rule in (row.get("rule_hits") or "").split():
            if rule in RULE_LABELS:
                labels.add(RULE_LABELS[rule])
        merged.append(labels)

    print(f"gold rows annotated: {len(rows)}")
    print(f"bundle:              {bundle.describe()}")

    mo_per_class, mo_macro, mo_lang = score(gold, model_only, langs)
    print_table("model only", mo_per_class, mo_macro, mo_lang)

    mg_per_class, mg_macro, mg_lang = score(gold, merged, langs)
    print_table("model + rules (what ships)", mg_per_class, mg_macro, mg_lang)

    print("\n=== rule ablation")
    print(f"  macro-F1 model only        {mo_macro:.3f}")
    print(f"  macro-F1 model + rules     {mg_macro:.3f}")
    print(f"  delta                      {mg_macro - mo_macro:+.3f}")
    print()
    print("Compare the macro-F1 above against the synthetic test figure in")
    print("docs/RESULTS.md section 3. A drop is expected and is the finding --")
    print("it quantifies synthetic-to-real distribution shift.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
