"""Turn archived traces into an annotation-ready CSV for the Stage 4 gold set.

    cd backend && uv run python scripts/gold_candidates.py '../traces/*.json' --out ../data/gold/candidates.csv
    make gold-candidates TRACES='path/to/*.json'

The gold set is the only evidence that this tool works on real websites; every
number before it is measured on synthetic data the project generated itself.
This script does the mechanical half — pulling real snippets out of captures,
deduplicating them, and sampling a set worth a human's time. The annotation
itself is human work and is not automated here, deliberately: labels produced by
the model being evaluated would make the evaluation circular.

Two sampling decisions that matter:

**Benign candidates are included, in quantity.** The obvious move is to export
only what the model flagged, but a gold set of model-flagged rows can only ever
measure precision. False negatives — the patterns the model *missed* — are
invisible in it, and those are the more interesting failure. Roughly half the
sample is drawn from candidates the model called benign.

**Sampling is stratified by predicted label and language**, not random. A random
sample of a real page is overwhelmingly benign English boilerplate, and would
spend the annotator's effort on the easy majority while producing single-digit
counts for the classes whose per-class F1 you actually need.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import random
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

#: Written by the annotator, read by gold_eval.py. Kept flat and CSV rather than
#: JSON so it opens in a spreadsheet -- annotation is done by humans, and the
#: tool they actually have is Excel or Sheets.
#:
#: Column order is chosen for the annotator, not for the writer. What they need
#: to judge a row (text, language, role) comes first, the cell they fill comes
#: immediately after, and the model's own opinion is pushed to the far right --
#: reading it first turns the exercise into measuring agreement with the model
#: rather than measuring the model. Provenance columns trail at the end because
#: a Daraz tracking URL is 800+ characters and would otherwise bury everything.
FIELDNAMES = [
    "text",
    "lang",
    "role",
    "tag",
    "gold_labels",  # <- ANNOTATOR FILLS THIS IN
    "notes",  # <- optional: why, or "unsure"
    "host",
    "model_labels",  # what the model said -- do not read while annotating
    "rule_hits",  # which structural rules fired
    "id",
    "url",
]


def load_entries(paths: list[Path]) -> list[dict[str, Any]]:
    """Every entry from every trace, tagged with the page it came from.

    Accepts both trace shapes for the same reason trace_report.py does: the
    extension's download button and the MinIO archive write different wrappers
    around identical entries.
    """
    entries: list[dict[str, Any]] = []
    for path in paths:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"skipping {path}: {exc}", file=sys.stderr)
            continue

        if isinstance(raw, list):
            rows, url = raw, ""
        elif isinstance(raw, dict) and "entries" in raw:
            rows, url = raw["entries"], raw.get("url", "")
        else:
            print(f"skipping {path}: unrecognised trace shape", file=sys.stderr)
            continue

        host = ""
        if url:
            try:
                host = urlparse(url).hostname or ""
            except ValueError:
                host = ""

        for row in rows:
            row = dict(row)
            row["_url"] = url
            row["_host"] = host
            entries.append(row)
    return entries


def guess_lang(text: str) -> str:
    """Devanagari vs Latin, by script.

    Hindi and Nepali share Devanagari and cannot be told apart this way. Both
    are emitted as ``dev`` for the annotator to correct, rather than guessing
    and quietly poisoning the per-language table with a coin flip.
    """
    return "dev" if any("ऀ" <= ch <= "ॿ" for ch in text) else "en"


def dedupe(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One row per distinct (text, role).

    Not per text alone: the same string genuinely means different things in
    different positions ("Free" as a price versus as a button), and role is an
    input to the model, so collapsing across roles would hide real disagreement.
    """
    seen: set[tuple[str, str]] = set()
    unique: list[dict[str, Any]] = []
    for entry in entries:
        text = (entry.get("text") or "").strip()
        if not text:
            continue
        key = (text, entry.get("role", "none"))
        if key in seen:
            continue
        seen.add(key)
        unique.append(entry)
    return unique


def stratified_sample(
    entries: list[dict[str, Any]], target: int, seed: int
) -> list[dict[str, Any]]:
    """Sample across (predicted label, language), half flagged / half benign."""
    rng = random.Random(seed)

    flagged: dict[str, list[dict[str, Any]]] = defaultdict(list)
    benign: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for entry in entries:
        labels = entry.get("findingLabels")
        lang = guess_lang(entry.get("text", ""))
        if labels:
            for label in labels:
                flagged[f"{label}|{lang}"].append(entry)
        elif labels == []:  # confirmed benign, not merely unresolved
            benign[f"benign|{lang}"].append(entry)

    picked: list[dict[str, Any]] = []
    picked_ids: set[str] = set()

    def add(row: dict[str, Any]) -> bool:
        rid = row.get("id", "")
        if rid in picked_ids:
            return False
        picked_ids.add(rid)
        picked.append(row)
        return True

    def take(pool: dict[str, list[dict[str, Any]]], budget: int) -> None:
        """Even share per stratum, then top up from whatever is left.

        The top-up matters: a strict per-stratum cap silently under-delivers
        whenever some strata are smaller than their share (a page with two
        scarcity phrasings but two hundred benign ones), and asking for 400
        rows and receiving 250 wastes the annotator's planning, not just the
        script's arithmetic.
        """
        if not pool:
            return
        taken = 0
        per_stratum = max(1, budget // len(pool))
        for key in sorted(pool):
            rows = pool[key][:]
            rng.shuffle(rows)
            for row in rows[:per_stratum]:
                if add(row):
                    taken += 1

        if taken >= budget:
            return
        leftovers = [row for key in sorted(pool) for row in pool[key]]
        rng.shuffle(leftovers)
        for row in leftovers:
            if taken >= budget:
                break
            if add(row):
                taken += 1

    # Half the budget to each side, so precision and recall are both measurable.
    take(flagged, target // 2)
    take(benign, target - len(picked))

    rng.shuffle(picked)
    return picked[:target]


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a gold-set annotation CSV from traces")
    ap.add_argument("traces", nargs="+", help="Trace JSON files (globs allowed)")
    ap.add_argument("--out", type=Path, default=Path("../data/gold/candidates.csv"))
    ap.add_argument(
        "--target",
        type=int,
        default=400,
        help="Rows to sample. docs/STAGES.md asks for 300+ (default 400)",
    )
    ap.add_argument("--seed", type=int, default=13, help="Sampling seed, for reproducibility")
    args = ap.parse_args()

    paths: list[Path] = []
    for pattern in args.traces:
        expanded = [Path(p) for p in glob.glob(pattern)]
        paths.extend(expanded if expanded else [Path(pattern)])

    entries = load_entries(paths)
    if not entries:
        print("No entries found. Check the paths.", file=sys.stderr)
        return 1

    unique = dedupe(entries)
    sample = stratified_sample(unique, args.target, args.seed)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDNAMES)
        writer.writeheader()
        for entry in sample:
            writer.writerow(
                {
                    "id": entry.get("id", ""),
                    "text": entry.get("text", ""),
                    "lang": guess_lang(entry.get("text", "")),
                    "tag": entry.get("tag", "span"),
                    "role": entry.get("role", "none"),
                    "host": entry.get("_host", ""),
                    # Query string dropped: on a marketplace it is tracking
                    # parameters, hundreds of characters of them, and host+path
                    # is enough to find the page again.
                    "url": entry.get("_url", "").split("?")[0],
                    "model_labels": " ".join(entry.get("findingLabels") or []),
                    "rule_hits": " ".join(entry.get("ruleHits") or []),
                    "gold_labels": "",
                    "notes": "",
                }
            )

    flagged = sum(1 for e in sample if e.get("findingLabels"))
    print(f"read      {len(entries):,} entries from {len(paths)} file(s)")
    print(f"unique    {len(unique):,} after dedupe on (text, role)")
    print(f"sampled   {len(sample):,} ({flagged} model-flagged, {len(sample) - flagged} benign)")
    print(f"written   {args.out}")
    print()
    print("Next: fill the `gold_labels` column. Space-separated labels, or the")
    print("literal word `benign` for no pattern. Rules: docs/ANNOTATION.md.")
    print("Annotate WITHOUT reading model_labels first, or you are measuring")
    print("your agreement with the model rather than the model's correctness.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
