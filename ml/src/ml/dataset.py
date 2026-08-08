"""Dataset loading, validation and leakage guards.

Run standalone to sanity-check the data before training::

    uv run python -m ml.dataset --check --data ../data/synthetic
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from ml.config import LABELS, LANGS, SPLIT_PRIMARY, Y_COLS

REQUIRED_COLUMNS = [
    "text",
    "labels",
    "primary_label",
    "lang",
    "tag",
    "role",
    "model_input",
    "template_id",
    "source",
    *Y_COLS,
]


def load_split(
    data_root: Path | str,
    split: str = SPLIT_PRIMARY,
    part: str = "train",
) -> pd.DataFrame:
    """Load one part (train/val/test) of one split."""
    path = Path(data_root) / split / f"{part}.csv"
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}. Did you unzip data/synthetic/?")
    df = pd.read_csv(path)
    _validate_columns(df, path)
    return df


def load_all_parts(
    data_root: Path | str,
    split: str = SPLIT_PRIMARY,
    strict: bool = False,
) -> dict[str, pd.DataFrame]:
    """Load train/val/test together and enforce that the split is honest.

    Template disjointness is a hard assertion: violating it invalidates every
    number you would report.

    Exact-duplicate text across parts is handled differently -- see
    ``drop_cross_part_duplicates``. Pass ``strict=True`` to raise on it instead.
    """
    parts = {p: load_split(data_root, split, p) for p in ("train", "val", "test")}
    if split == SPLIT_PRIMARY:
        assert_template_disjoint(parts)
    if strict:
        assert_no_text_overlap(parts)
    else:
        parts = drop_cross_part_duplicates(parts)
    return parts


def _validate_columns(df: pd.DataFrame, path: Path) -> None:
    missing = [c for c in REQUIRED_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{path} is missing columns: {missing}")


# ---------------------------------------------------------------------------
# Leakage guards
# ---------------------------------------------------------------------------


def assert_template_disjoint(parts: dict[str, pd.DataFrame]) -> None:
    """No ``template_id`` may appear in more than one part.

    This is the single most important check in the project. The dataset is
    synthetic and template-generated, so thousands of rows share a skeleton with
    only slot values differing. If the same template appears in train and test,
    the model can score >0.98 by memorising skeletons while having learned
    nothing transferable. The number would be meaningless and the failure
    invisible.

    This is a hard failure, never a warning.
    """
    sets = {name: set(df["template_id"]) for name, df in parts.items()}
    problems = []
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        overlap = sets[a] & sets[b]
        if overlap:
            problems.append(
                f"{a} & {b}: {len(overlap)} shared templates, e.g. {sorted(overlap)[:3]}"
            )
    if problems:
        raise AssertionError("Template leakage detected:\n  " + "\n  ".join(problems))


def find_cross_part_duplicates(
    parts: dict[str, pd.DataFrame],
) -> dict[tuple[str, str], set[str]]:
    """Find exact text strings that appear in more than one part."""
    sets = {name: set(df["text"]) for name, df in parts.items()}
    found: dict[tuple[str, str], set[str]] = {}
    for a, b in (("train", "val"), ("train", "test"), ("val", "test")):
        overlap = sets[a] & sets[b]
        if overlap:
            found[(a, b)] = overlap
    return found


def assert_no_text_overlap(parts: dict[str, pd.DataFrame]) -> None:
    """Strict variant: raise if any exact text straddles two parts."""
    found = find_cross_part_duplicates(parts)
    if found:
        detail = "; ".join(f"{a} & {b}: {len(v)} rows" for (a, b), v in found.items())
        raise AssertionError(f"Exact text overlap -- {detail}")


def drop_cross_part_duplicates(
    parts: dict[str, pd.DataFrame],
    verbose: bool = True,
) -> dict[str, pd.DataFrame]:
    """Remove strings that appear in more than one part, keeping train's copy.

    Why this is expected rather than a bug
    --------------------------------------
    Templates are disjoint across parts, but two *different* templates can still
    render the same short string. ``"Only 2 left"`` might be produced by both a
    scarcity template and a benign inventory template after slot filling. The
    generator guarantees uniqueness *within* the dataset as a whole, not that
    independent templates never collide.

    Why drop from val/test rather than train
    ----------------------------------------
    The problem with a duplicate is only that it lets the model be *evaluated* on
    a string it was *trained* on. Removing it from the evaluation side eliminates
    that while keeping all training signal. Removing it from train instead would
    discard signal for no benefit.

    Expect a handful of rows out of 27,000. If it is more than a few hundred,
    something is wrong with the generator and you should investigate rather than
    silently drop them.
    """
    found = find_cross_part_duplicates(parts)
    if not found:
        return parts

    out = {k: v.copy() for k, v in parts.items()}
    removed: dict[str, int] = {"val": 0, "test": 0}

    # Resolve in precedence order: train wins over val, and both win over test.
    for later, earlier_parts in (("val", ["train"]), ("test", ["train", "val"])):
        earlier_texts: set[str] = set()
        for e in earlier_parts:
            earlier_texts |= set(out[e]["text"])
        mask = out[later]["text"].isin(earlier_texts)
        n = int(mask.sum())
        if n:
            out[later] = out[later][~mask].reset_index(drop=True)
            removed[later] = n

    if verbose and any(removed.values()):
        total = sum(removed.values())
        print(
            f"NOTE: dropped {total} evaluation row(s) whose exact text also appears "
            f"in an earlier part (val: {removed['val']}, test: {removed['test']})."
        )
        print(
            "      Cause: two different templates rendered an identical short string. "
            "Templates remain disjoint; this keeps evaluation clean."
        )
        example = next(iter(next(iter(found.values()))))
        print(f"      Example: {example!r}")

    # Post-condition: evaluation is now genuinely unseen.
    assert_no_text_overlap(out)
    return out


# ---------------------------------------------------------------------------
# Label handling
# ---------------------------------------------------------------------------


def labels_matrix(df: pd.DataFrame) -> np.ndarray:
    """Return the (n, 8) float32 multi-hot target matrix in frozen label order."""
    return df[Y_COLS].to_numpy(dtype=np.float32)


def class_support(df: pd.DataFrame) -> pd.Series:
    """Positive count per label (a row may count toward several labels)."""
    return pd.Series({lab: int(df[f"y_{lab}"].sum()) for lab in LABELS})


def pos_weights(df: pd.DataFrame) -> np.ndarray:
    """Per-class ``pos_weight`` for BCEWithLogitsLoss.

    Only needed if a class collapses to all-negative. This dataset is close to
    balanced by construction, so prefer leaving it unused -- reweighting a
    balanced dataset usually hurts calibration and makes threshold tuning
    harder.
    """
    y = labels_matrix(df)
    pos = y.sum(axis=0)
    neg = len(y) - pos
    return np.where(pos > 0, neg / np.maximum(pos, 1), 1.0).astype(np.float32)


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def describe(parts: dict[str, pd.DataFrame]) -> str:
    out: list[str] = []
    for name, df in parts.items():
        out.append(
            f"\n=== {name}: {len(df):,} rows, {df['template_id'].nunique()} templates"
        )
        counts = df["lang"].value_counts().sort_index()
        out.append("  per language: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
        sup = class_support(df)
        out.append("  label positives:")
        for lab in LABELS:
            out.append(f"    {lab:<16} {sup[lab]:>6,}")
        multi = int((df[Y_COLS].sum(axis=1) > 1).sum())
        out.append(f"  multi-label rows: {multi:,} ({multi / len(df):.1%})")
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate the dark pattern dataset")
    ap.add_argument("--data", default="../data/synthetic", help="dataset root")
    ap.add_argument("--split", default=SPLIT_PRIMARY)
    ap.add_argument("--check", action="store_true", help="run validation and exit")
    ap.add_argument(
        "--strict",
        action="store_true",
        help="fail on cross-part duplicate text instead of dropping it",
    )
    args = ap.parse_args()

    print(f"Loading {args.split} from {args.data} ...")
    try:
        parts = load_all_parts(args.data, args.split, strict=args.strict)
    except (AssertionError, FileNotFoundError, ValueError) as exc:
        print(f"\nFAILED: {exc}", file=sys.stderr)
        return 1

    print(describe(parts))
    print("\nAll guards passed:")
    print("  - required columns present")
    print("  - templates disjoint across train/val/test")
    print("  - no exact text shared between parts")
    print(f"  - languages: {LANGS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
