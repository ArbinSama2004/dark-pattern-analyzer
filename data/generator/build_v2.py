# -*- coding: utf-8 -*-
"""Build dataset v2 = v1 + adversarial hard negatives.

v1 is left completely untouched in data/synthetic/ so its metrics stay
reproducible. v2 is written to data/synthetic_v2/.

Design choices
--------------
* Hard-negative templates get their own ``template_id`` namespace
  (``hardneg:<counterpart>:<lang>:<idx>``) and are split by template, so the
  template-disjointness guarantee still holds in v2.
* v1 rows keep their original split assignment. Therefore v1's test set is a
  strict subset of v2's test set, and the two baselines differ only by the added
  hard negatives -- which is exactly the comparison we want to report.
* Every hard negative is labelled benign. ``counterpart`` is recorded in the
  ``source`` column so per-group error analysis is possible later.

Run from this directory:  python3 build_v2.py
"""

from __future__ import annotations

import csv
import importlib.util
import json
import pathlib
import random
import sys

HERE = pathlib.Path(__file__).resolve().parent
PROJ = HERE.parent.parent
V1 = PROJ / "data" / "synthetic"
V2 = PROJ / "data" / "synthetic_v2"

SEED = 13
TARGET_PER_GROUP = 100  # per counterpart class, per language
PRIMARY = "split_template_disjoint"

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


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gen = _load("generate_dataset")
HARD_NEG = {}
HARD_NEG.update(_load("hardneg_templates_a").HARD_NEG_A)
HARD_NEG.update(_load("hardneg_templates_b").HARD_NEG_B)


def build_model_input(text: str, tag: str, role: str) -> str:
    """Must stay byte-identical to ml/config.build_model_input."""
    return f"[TAG={tag}] [ROLE={role}] {text}"


def make_row(text: str, lang: str, tag: str, role: str, tpl_id: str, counterpart: str):
    row = {
        "text": text,
        "labels": "benign",
        "primary_label": "benign",
        "lang": lang,
        "tag": tag,
        "role": role,
        "model_input": build_model_input(text, tag, role),
        "template_id": tpl_id,
        "source": f"hard_negative_v2:{counterpart}",
    }
    for col in Y_COLS:
        row[col] = 0
    row["y_benign"] = 1
    return row


def generate_hard_negatives() -> list[dict]:
    rng = random.Random(SEED)
    rows: list[dict] = []
    per_group: dict[tuple[str, str], int] = {}

    for counterpart in sorted(HARD_NEG):
        for lang in ("en", "hi", "ne"):
            templates = HARD_NEG[counterpart][lang]
            seen: set[tuple[str, str, str]] = set()
            group: list[dict] = []
            misses = 0

            while len(group) < TARGET_PER_GROUP and misses < 400:
                progressed = False
                for idx, (tpl, tag, role) in enumerate(templates):
                    if len(group) >= TARGET_PER_GROUP:
                        break
                    has_slot = "{" in tpl
                    # Slot-free strings (e.g. "No thanks") cannot vary by text,
                    # so vary the structural context instead -- which is a real
                    # signal, since model_input encodes tag and role.
                    if has_slot:
                        variants = [(tag, role)]
                    else:
                        variants = [(t, role) for t in ("button", "a", "span", "div")]

                    for vtag, vrole in variants:
                        if len(group) >= TARGET_PER_GROUP:
                            break
                        text = gen.fill(tpl, lang, rng) if has_slot else tpl
                        key = (text, vtag, vrole)
                        if key in seen:
                            misses += 1
                            continue
                        seen.add(key)
                        tpl_id = f"hardneg:{counterpart}:{lang}:{idx:02d}"
                        group.append(
                            make_row(text, lang, vtag, vrole, tpl_id, counterpart)
                        )
                        progressed = True
                if not progressed:
                    break

            per_group[(counterpart, lang)] = len(group)
            rows.extend(group)

    print("Hard negatives generated per group:")
    for (cp, lang), n in sorted(per_group.items()):
        print(f"  {cp:<16} {lang}  {n:>4}")
    print(f"  TOTAL {len(rows)}")
    return rows


def split_hard_negatives(rows: list[dict]) -> dict[str, list[dict]]:
    """Assign whole templates to parts, ~60/15/25, per counterpart and language."""
    rng = random.Random(SEED + 1)
    by_group: dict[tuple[str, str], list[str]] = {}
    for r in rows:
        _, cp, lang, _ = r["template_id"].split(":")
        by_group.setdefault((cp, lang), [])
        if r["template_id"] not in by_group[(cp, lang)]:
            by_group[(cp, lang)].append(r["template_id"])

    assignment: dict[str, str] = {}
    for group, tpls in by_group.items():
        tpls = sorted(tpls)
        rng.shuffle(tpls)
        n = len(tpls)
        n_val = max(1, round(n * 0.15))
        n_test = max(1, round(n * 0.25))
        n_train = n - n_val - n_test
        if n_train < 1:  # tiny groups: guarantee train coverage
            n_train, n_val, n_test = max(1, n - 2), min(1, n - 1), max(0, n - 2)
        for t in tpls[:n_train]:
            assignment[t] = "train"
        for t in tpls[n_train : n_train + n_val]:
            assignment[t] = "val"
        for t in tpls[n_train + n_val :]:
            assignment[t] = "test"

    parts: dict[str, list[dict]] = {"train": [], "val": [], "test": []}
    for r in rows:
        parts[assignment[r["template_id"]]].append(r)
    return parts


def read_csv(path: pathlib.Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def write_csv(path: pathlib.Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def main() -> int:
    if not (V1 / PRIMARY / "train.csv").exists():
        print(f"ERROR: v1 not found at {V1}", file=sys.stderr)
        return 1

    hn = generate_hard_negatives()
    hn_parts = split_hard_negatives(hn)

    rng = random.Random(SEED + 2)
    all_rows: list[dict] = []
    summary = {}

    print(f"\nWriting {PRIMARY} ...")
    for part in ("train", "val", "test"):
        v1_rows = read_csv(V1 / PRIMARY / f"{part}.csv")
        merged = v1_rows + hn_parts[part]
        rng.shuffle(merged)
        write_csv(V2 / PRIMARY / f"{part}.csv", merged)
        all_rows.extend(merged)
        summary[part] = {
            "total": len(merged),
            "v1": len(v1_rows),
            "hard_negatives": len(hn_parts[part]),
        }
        print(
            f"  {part:<6} {len(merged):>7,} rows "
            f"(v1 {len(v1_rows):,} + hardneg {len(hn_parts[part]):,})"
        )

    write_csv(V2 / "dataset_all.csv", all_rows)

    print("\nWriting split_random ...")
    shuffled = list(all_rows)
    random.Random(SEED + 3).shuffle(shuffled)
    n = len(shuffled)
    n_tr, n_va = int(n * 0.70), int(n * 0.15)
    for part, chunk in (
        ("train", shuffled[:n_tr]),
        ("val", shuffled[n_tr : n_tr + n_va]),
        ("test", shuffled[n_tr + n_va :]),
    ):
        write_csv(V2 / "split_random" / f"{part}.csv", chunk)
        print(f"  {part:<6} {len(chunk):>7,} rows")

    label_positives = {
        lab: sum(1 for r in all_rows if str(r[f"y_{lab}"]) == "1") for lab in LABELS
    }
    stats = {
        "version": "v2",
        "description": "v1 plus adversarial hard negatives (benign text using "
        "dark-pattern vocabulary legitimately)",
        "total_rows": len(all_rows),
        "hard_negatives_added": len(hn),
        "splits": summary,
        "label_positives": label_positives,
        "templates": len({r["template_id"] for r in all_rows}),
        "seed": SEED,
    }
    (V2 / "stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")

    print(f"\nv2 total: {len(all_rows):,} rows "
          f"({len(hn):,} hard negatives added to {len(all_rows) - len(hn):,} v1 rows)")
    print("label positives:")
    for lab in LABELS:
        print(f"  {lab:<16} {label_positives[lab]:>7,}")
    print(f"\nWrote {V2}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
