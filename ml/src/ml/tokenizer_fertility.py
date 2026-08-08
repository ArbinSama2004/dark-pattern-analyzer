"""Compare how badly each candidate tokenizer fragments each language.

Run this BEFORE training. It is cheap (a few minutes, no GPU) and it can change
which model you train.

    uv run python -m ml.tokenizer_fertility --data ../data/synthetic

Why it matters
--------------
"Fertility" is the average number of subword tokens a tokenizer produces per
whitespace-delimited word. A tokenizer that was barely exposed to Nepali during
pretraining will shatter Nepali words into many meaningless fragments. Two
consequences follow, both bad:

1. The model sees fragments rather than morphemes, so it has to relearn word
   structure from a small fine-tuning set.
2. Sequence length is consumed by noise, so long snippets truncate earlier.

A large Nepali-vs-English fertility gap is the single best early predictor that
Nepali F1 will lag. Measuring it takes ten minutes; discovering it after a full
training run costs a day.

Decision rule
-------------
If mDistilBERT's Nepali fertility exceeds roughly 1.5x MuRIL's, make MuRIL the
primary model and keep mDistilBERT as a documented comparison.

Record the table in docs/RESULTS.md either way. Nepali tokenizer coverage is a
legitimate finding, not a chore.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from ml.config import CANDIDATE_MODELS, LANGS, SPLIT_PRIMARY


def unk_rate(tokenizer, texts: list[str]) -> float:
    """Fraction of produced tokens that are the unknown token.

    Anything above ~0.5% for a language means that tokenizer effectively cannot
    read the script.
    """
    unk = tokenizer.unk_token_id
    if unk is None:
        return 0.0
    total = 0
    unks = 0
    for t in texts:
        ids = tokenizer(t, add_special_tokens=False)["input_ids"]
        total += len(ids)
        unks += sum(1 for i in ids if i == unk)
    return unks / max(total, 1)


def fertility(tokenizer, texts: list[str]) -> tuple[float, float]:
    """Return (tokens per word, mean tokens per snippet)."""
    tok_counts = []
    word_counts = []
    for t in texts:
        ids = tokenizer(t, add_special_tokens=False)["input_ids"]
        tok_counts.append(len(ids))
        word_counts.append(max(len(t.split()), 1))
    total_tokens = sum(tok_counts)
    total_words = sum(word_counts)
    return total_tokens / total_words, total_tokens / len(texts)


def p95_length(tokenizer, texts: list[str]) -> int:
    """95th percentile token length. Sanity-checks max_length=64."""
    lens = [len(tokenizer(t, add_special_tokens=True)["input_ids"]) for t in texts]
    return int(pd.Series(lens).quantile(0.95))


def analyse(
    data_root: Path | str,
    sample_per_lang: int = 600,
    seed: int = 13,
) -> pd.DataFrame:
    from transformers import AutoTokenizer

    df = pd.read_csv(Path(data_root) / SPLIT_PRIMARY / "train.csv")

    samples: dict[str, list[str]] = {}
    for lang in LANGS:
        sub = df[df["lang"] == lang]["text"].dropna()
        n = min(sample_per_lang, len(sub))
        samples[lang] = sub.sample(n=n, random_state=seed).tolist()

    rows = []
    for key, model_name in CANDIDATE_MODELS.items():
        print(f"\n--- {key}: {model_name}")
        try:
            tok = AutoTokenizer.from_pretrained(model_name)
        except Exception as exc:  # noqa: BLE001 - network/gated model failures
            print(f"    SKIPPED ({type(exc).__name__}: {exc})")
            continue

        for lang in LANGS:
            fert, per_snippet = fertility(tok, samples[lang])
            rows.append(
                {
                    "model_key": key,
                    "model": model_name,
                    "lang": lang,
                    "fertility": round(fert, 3),
                    "tokens_per_snippet": round(per_snippet, 1),
                    "p95_tokens": p95_length(tok, samples[lang]),
                    "unk_rate": round(unk_rate(tok, samples[lang]), 5),
                    "vocab_size": tok.vocab_size,
                }
            )
            print(f"    {lang}: fertility={fert:.3f}  unk={rows[-1]['unk_rate']:.4%}")

    return pd.DataFrame(rows)


def recommend(res: pd.DataFrame) -> str:
    """Apply the decision rule and explain the outcome in words."""
    if res.empty:
        return "No tokenizers could be loaded (offline?). Re-run with network access."

    pivot = res.pivot(index="model_key", columns="lang", values="fertility")
    lines = ["", "Fertility (subword tokens per word, lower is better)", pivot.to_string(), ""]

    if "ne" not in pivot.columns:
        return "\n".join(lines)

    ne = pivot["ne"].dropna()
    best_key = ne.idxmin()
    lines.append(f"Lowest Nepali fertility: {best_key} ({ne[best_key]:.3f})")

    if "mdistilbert" in ne.index and "muril" in ne.index:
        ratio = ne["mdistilbert"] / ne["muril"]
        lines.append(f"mDistilBERT / MuRIL Nepali fertility ratio: {ratio:.2f}x")
        if ratio > 1.5:
            lines += [
                "",
                ">>> RECOMMENDATION: use google/muril-base-cased as PRIMARY.",
                "    mDistilBERT fragments Nepali substantially worse. Keep it as a",
                "    documented comparison in your report -- the gap is a finding.",
            ]
        else:
            lines += [
                "",
                ">>> RECOMMENDATION: keep distilbert-base-multilingual-cased as PRIMARY.",
                "    Nepali fragmentation is acceptable, and it is smaller and faster",
                "    to serve. Train MuRIL later only if Nepali F1 disappoints.",
            ]

    if "en" in pivot.columns:
        gap = (pivot["ne"] / pivot["en"]).dropna()
        lines += ["", "Nepali-to-English fertility ratio (script disadvantage):"]
        lines += [f"    {k}: {v:.2f}x" for k, v in gap.items()]

    worst_unk = res.loc[res["unk_rate"].idxmax()]
    if worst_unk["unk_rate"] > 0.005:
        lines += [
            "",
            f"WARNING: {worst_unk['model_key']} has {worst_unk['unk_rate']:.2%} UNK on "
            f"{worst_unk['lang']}. That tokenizer cannot read the script -- exclude it.",
        ]

    p95 = int(res["p95_tokens"].max())
    lines += ["", f"Max p95 token length across all models/languages: {p95}"]
    if p95 > 64:
        lines.append(f"    Consider raising max_length from 64 to {min(128, ((p95 // 16) + 1) * 16)}.")
    else:
        lines.append("    max_length=64 is sufficient.")

    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="Tokenizer fertility comparison")
    ap.add_argument("--data", default="../data/synthetic")
    ap.add_argument("--sample", type=int, default=600, help="snippets per language")
    ap.add_argument("--out", default="reports", help="where to write results")
    args = ap.parse_args()

    res = analyse(args.data, sample_per_lang=args.sample)
    if res.empty:
        print("\nNo results.")
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    res.to_csv(out / "tokenizer_fertility.csv", index=False)
    (out / "tokenizer_fertility.json").write_text(
        json.dumps(res.to_dict(orient="records"), indent=2), encoding="utf-8"
    )

    print("\n" + "=" * 68)
    print(recommend(res))
    print("=" * 68)
    print(f"\nWritten to {out}/tokenizer_fertility.csv")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
