"""Turn one or more trace JSON files into a readable Markdown report.

    cd backend && uv run python scripts/trace_report.py path/to/trace.json
    cd backend && uv run python scripts/trace_report.py *.json --out reports/

Accepts either trace shape, because two different code paths produce them and
neither should have to match the other's format for this to work:

  * the extension's own "Download debug trace" button (content.ts's
    exportTrace) -- a flat JSON array of entries, pretty-printed
  * a capture pulled back out of the MinIO archive (POST /v1/traces' request
    body, as GET /v1/traces would let you fetch by key) -- a
    {scan_id, url, page_score, entries} object, compact (no indentation --
    MinIO stores what the extension sent, and the extension sends compact
    JSON over the wire on purpose: indentation is ~30-40% more bytes for
    something no human reads until this script runs)

Nothing here is MinIO-specific or backend-specific. It reads plain JSON files
off disk, so it works equally well on a file downloaded straight from the
extension's popup.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def normalize(raw: Any, *, source_name: str) -> dict[str, Any]:
    """Both trace shapes, reduced to one internal shape.

    Doing this once at the boundary is what lets everything below stay
    agnostic to which button produced the file.
    """
    if isinstance(raw, list):
        return {"scan_id": None, "url": None, "page_score": None, "entries": raw}
    if isinstance(raw, dict) and "entries" in raw:
        return raw
    raise ValueError(
        f"{source_name}: unrecognised trace shape (expected a JSON array or an "
        "object with an 'entries' key)"
    )


def host_of(url: str | None) -> str:
    if not url:
        return "(unknown page)"
    try:
        return urlparse(url).hostname or url
    except ValueError:
        return url


def status_of(entry: dict[str, Any]) -> str:
    """Mirrors the three-way distinction content.ts's own trace keeps.

    Collapsing these into one "not flagged" bucket is exactly what would make
    a report useless for the purpose it exists for -- benign-and-confirmed is
    the pipeline working, pending is the pipeline still running, and neither
    should look like the other.
    """
    labels = entry.get("findingLabels")
    if labels is None:
        return "pending" if entry.get("sentToModel") else "not sent (duplicate)"
    return "flagged" if labels else "benign"


def render_markdown(trace: dict[str, Any], *, examples_per_label: int) -> str:
    entries: list[dict[str, Any]] = trace["entries"]
    host = host_of(trace.get("url"))

    statuses = Counter(status_of(e) for e in entries)
    label_counts: Counter[str] = Counter()
    label_examples: dict[str, list[dict[str, Any]]] = {}
    for e in entries:
        for label in e.get("findingLabels") or []:
            label_counts[label] += 1
            label_examples.setdefault(label, []).append(e)

    role_counts = Counter(e.get("role", "none") for e in entries)
    rule_corroborated = sum(1 for e in entries if e.get("ruleHits"))

    lines: list[str] = []
    w = lines.append

    w(f"# Trace report — {host}")
    w("")
    if trace.get("url"):
        w(f"**Page:** {trace['url']}")
    if trace.get("scan_id"):
        w(f"**Scan id:** `{trace['scan_id']}`")
    if trace.get("page_score") is not None:
        band = (
            "low" if trace["page_score"] < 30 else "medium" if trace["page_score"] < 65 else "high"
        )
        w(f"**Page score:** {trace['page_score']}/100 ({band})")
    w("")

    w("## Summary")
    w("")
    w("| | |")
    w("|---|---|")
    w(f"| Candidates extracted | {len(entries)} |")
    w(f"| Confirmed benign | {statuses.get('benign', 0)} |")
    w(f"| Flagged (at least one label) | {statuses.get('flagged', 0)} |")
    w(f"| Still awaiting a model response | {statuses.get('pending', 0)} |")
    w(f"| Not sent (duplicate / churn-suppressed) | {statuses.get('not sent (duplicate)', 0)} |")
    w(
        f"| Corroborated by a structural rule | {rule_corroborated} "
        f"({rule_corroborated * 100 // max(len(entries), 1)}%) |"
    )
    w("")

    if label_counts:
        w("## Findings by label")
        w("")
        w("| Label | Count | Share of flagged |")
        w("|---|---:|---:|")
        total_flagged = sum(label_counts.values())
        for label, count in label_counts.most_common():
            w(f"| {label} | {count} | {count * 100 // total_flagged}% |")
        w("")

        for label, count in label_counts.most_common():
            w(f"### {label} ({count})")
            w("")
            examples = label_examples[label][:examples_per_label]
            for e in examples:
                text = (e.get("text") or "").replace("\n", " ").strip()
                if len(text) > 100:
                    text = text[:97] + "..."
                evidence = (
                    f"rule: {', '.join(e['ruleHits'])}" if e.get("ruleHits") else "model only"
                )
                w(f"- **\"{text}\"** — `<{e.get('tag', '?')}>` as `{e.get('role', '?')}` ({evidence})")
            if len(label_examples[label]) > examples_per_label:
                remaining = len(label_examples[label]) - examples_per_label
                w(f"- *...and {remaining} more*")
            w("")
    else:
        w("## Findings by label")
        w("")
        w("Nothing was flagged in this capture.")
        w("")

    w("## Extraction shape")
    w("")
    w("What kind of element the candidates came from — useful for spotting a role")
    w("that the extractor is systematically getting wrong on this page.")
    w("")
    w("| Role | Count |")
    w("|---|---:|")
    for role, count in role_counts.most_common(15):
        w(f"| {role} | {count} |")
    if len(role_counts) > 15:
        w(f"| *...{len(role_counts) - 15} more roles* | |")
    w("")

    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("files", nargs="+", type=Path, help="Trace JSON file(s)")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write .md file(s) here (directory if multiple inputs, or a single "
        "file path for one input). Prints to stdout if omitted.",
    )
    parser.add_argument(
        "--examples",
        type=int,
        default=8,
        metavar="N",
        help="Max example snippets shown per label (default: 8)",
    )
    args = parser.parse_args()

    if args.out and len(args.files) > 1:
        args.out.mkdir(parents=True, exist_ok=True)

    for path in args.files:
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            trace = normalize(raw, source_name=path.name)
        except (json.JSONDecodeError, ValueError) as exc:
            print(f"skipping {path}: {exc}", file=sys.stderr)
            continue

        report = render_markdown(trace, examples_per_label=args.examples)

        if args.out is None:
            print(report)
            print("\n---\n")
        else:
            out_path = args.out / f"{path.stem}.md" if args.out.is_dir() else args.out
            out_path.write_text(report, encoding="utf-8")
            print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
