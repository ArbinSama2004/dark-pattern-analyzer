# -*- coding: utf-8 -*-
"""Build dataset v2.1 by patching labels in v2. No regeneration, no resplitting.

Why patch instead of regenerate
-------------------------------
Re-running generate_dataset.py would reshuffle template->split assignment, so any
metric change would be a mix of "labels fixed" and "different split". Patching
keeps every row's text, lang, tag, role, template_id and split assignment
byte-identical, so v2 -> v2.1 differs ONLY in labels. That makes the comparison
attributable.

What changes and why
--------------------
Annotation rule now written down: a statistic is manipulative when it induces
urgency or peer pressure via UNVERIFIABLE REAL-TIME ACTIVITY; it is benign when it
is a STATIC VERIFIABLE AGGREGATE. Same test for deadlines: a real stated cutoff is
benign, a fabricated or resetting one is dark.

Three template families violated that rule:

1. social_proof:*:05  "Rated by {NUM_BIG} verified buyers in {CITY}"
   A static, auditable rating count. Meanwhile the generator's own benign list
   already contained "{NUM_BIG} verified reviews". The same concept was labelled
   both ways, which is why social_proof's tuned threshold collapsed to 0.13 and
   19% of its rows leaked into other classes.

2. social_proof:*:10  "Bestseller -- {NUM_BIG} sold this week"
   A verifiable sales aggregate with no real-time framing.

3. false_urgency:*:16 "Order in {TIME} to get delivery in {DAYS} days"
   A legitimate shipping cutoff. The model correctly predicted [] on these and was
   penalised for it -- 4 of 8 sampled false negatives were this one family.

Also dropped: hardneg:social_proof:*:00 "{NUM_BIG} verified reviews", which
duplicated an existing v1 benign template and contributed nothing but redundancy.

Run from this directory:  python3 relabel_v2_1.py
"""

from __future__ import annotations

import csv
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
PROJ = HERE.parent.parent
SRC = PROJ / "data" / "synthetic_v2"
DEST = PROJ / "data" / "synthetic_v2_1"

PRIMARY = "split_template_disjoint"
RANDOM = "split_random"
PARTS = ("train", "val", "test")

LABELS = [
    "confirmshaming",
    "false_urgency",
    "forced_action",
    "obstruction",
    "scarcity",
    "sneaking",
    "social_proof",
    "benign",
]
Y_COLS = [f"y_{lab}" for lab in LABELS]
FIELDS = [
    "text", "labels", "primary_label", "lang", "tag", "role",
    "model_input", "template_id", "source", *Y_COLS,
]

LANGS = ("en", "hi", "ne")

# template_id -> new single label
TO_BENIGN = {
    f"social_proof:{lang}:05": "benign" for lang in LANGS
}
TO_BENIGN.update({f"social_proof:{lang}:10": "benign" for lang in LANGS})
TO_BENIGN.update({f"false_urgency:{lang}:16": "benign" for lang in LANGS})

# template_ids removed entirely (exact duplicates of an existing v1 benign template)
DROP = {f"hardneg:social_proof:{lang}:00" for lang in LANGS}

REASONS = {
    "social_proof:*:05": "static verifiable rating count, not real-time activity",
    "social_proof:*:10": "verifiable sales aggregate, no urgency framing",
    "false_urgency:*:16": "legitimate stated shipping cutoff, not a fabricated deadline",
    "hardneg:social_proof:*:00": "duplicate of an existing v1 benign template",
}


def patch_row(row: dict) -> dict | None:
    """Return the patched row, or None if it should be dropped."""
    tid = row["template_id"]
    if tid in DROP:
        return None
    new = TO_BENIGN.get(tid)
    if new is None:
        return row

    row = dict(row)
    row["labels"] = new
    row["primary_label"] = new
    for col in Y_COLS:
        row[col] = 0
    row[f"y_{new}"] = 1
    if "relabel_v2_1" not in row["source"]:
        row["source"] = f"{row['source']}|relabel_v2_1"
    return row


def read_csv(path: pathlib.Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def write_csv(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def process(split: str) -> tuple[list[dict], dict]:
    counts = {"relabelled": 0, "dropped": 0, "per_template": {}}
    all_rows: list[dict] = []

    for part in PARTS:
        src = SRC / split / f"{part}.csv"
        rows_in = read_csv(src)
        rows_out: list[dict] = []
        for r in rows_in:
            tid = r["template_id"]
            out = patch_row(r)
            if out is None:
                counts["dropped"] += 1
                counts["per_template"][tid] = counts["per_template"].get(tid, 0) + 1
                continue
            if tid in TO_BENIGN:
                counts["relabelled"] += 1
                counts["per_template"][tid] = counts["per_template"].get(tid, 0) + 1
            rows_out.append(out)

        write_csv(DEST / split / f"{part}.csv", rows_out)
        all_rows.extend(rows_out)
        print(f"  {part:<6} {len(rows_in):>7,} -> {len(rows_out):>7,} rows")

    return all_rows, counts


def main() -> int:
    if not (SRC / PRIMARY / "train.csv").exists():
        print(f"ERROR: v2 not found at {SRC}", file=sys.stderr)
        return 1

    print("Annotation rule applied:")
    for k, v in REASONS.items():
        print(f"  {k:<28} {v}")

    print(f"\n{PRIMARY}:")
    primary_rows, counts = process(PRIMARY)

    print(f"\n{RANDOM}:")
    process(RANDOM)

    write_csv(DEST / "dataset_all.csv", primary_rows)

    print(f"\nRows relabelled to benign: {counts['relabelled']:,}")
    print(f"Rows dropped:              {counts['dropped']:,}")
    print("\nPer template:")
    for tid, n in sorted(counts["per_template"].items()):
        action = "dropped" if tid in DROP else "-> benign"
        print(f"  {tid:<32} {n:>5}  {action}")

    positives = {
        lab: sum(1 for r in primary_rows if str(r[f"y_{lab}"]) == "1") for lab in LABELS
    }
    print("\nLabel positives (v2.1, primary split):")
    for lab in LABELS:
        print(f"  {lab:<16} {positives[lab]:>7,}")

    stats = {
        "version": "v2.1",
        "derived_from": "synthetic_v2",
        "method": "label patch only -- text, splits and template_ids unchanged",
        "annotation_rule": (
            "Manipulative when it induces urgency or peer pressure via unverifiable "
            "real-time activity; benign when it is a static verifiable aggregate. "
            "A real stated deadline is benign; a fabricated or resetting one is dark."
        ),
        "relabelled_to_benign": sorted(TO_BENIGN),
        "dropped_templates": sorted(DROP),
        "reasons": REASONS,
        "rows_relabelled": counts["relabelled"],
        "rows_dropped": counts["dropped"],
        "total_rows": len(primary_rows),
        "label_positives": positives,
    }
    (DEST / "stats.json").write_text(json.dumps(stats, indent=2, ensure_ascii=False),
                                     encoding="utf-8")
    print(f"\nWrote {DEST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
