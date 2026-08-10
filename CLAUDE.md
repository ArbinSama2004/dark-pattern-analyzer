# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A multilingual (English/Hindi/Nepali) dark-pattern detector for e-commerce sites:
a fine-tuned MuRIL classifier plus a deterministic rule engine, served by FastAPI
and surfaced through an MV3 Chrome extension.

Three independent parts with **separate dependency sets**. `ml/` needs PyTorch
(~2.5 GB), `backend/` needs only ONNX Runtime (~120 MB), `frontend/` is npm. The
backend never imports from `ml/` — the only interface between them is the artifact
bundle in `ml/artifacts/model_v1/`. Keep it that way.

## Commands

`make help` lists everything. The ones that matter:

```bash
make test          # backend (200) + frontend (180). ml/ has no unit tests by design
make lint          # ruff on ml + backend, tsc on frontend
make dev           # backend API on :8000
make ext           # extension dev build
make smoke-backend # loads the real graph; MUST print scarcity=0.626
make parity        # PyTorch vs ONNX agreement — ml/'s real correctness gate
make bench         # inference latency
```

Use `uv run` inside `ml/` and `backend/`, and `npm` inside `frontend/`. **Never
`pnpm`** — there is no pnpm lockfile, and Makefile targets using it were a
long-standing bug. `ruff` is an optional dep: it needs `uv run --extra dev ruff`.

## The five invariants

These are enforced in code and abort startup rather than degrading. Do not weaken
any of them to make something pass.

1. **Label order is frozen** — `confirmshaming, false_urgency, forced_action,
   obstruction, scarcity, sneaking, social_proof, benign`. It is baked into the
   ONNX output axis, `thresholds.json` and every cache key. Reordering silently
   remaps every prediction and nothing raises.
2. **`build_model_input` is byte-identical** between `ml/` and `backend/`. A test
   guards it. Feature skew between training and serving is silent and devastating.
3. **Thresholds load from `thresholds.json`**, never from a literal.
4. **Model version is in every cache key.**
5. **Only template-disjoint metrics are reported.** The random split leaks
   templates and inflates macro-F1 by ~0.09.

## Traps already paid for — do not rediscover these

- **A 0.1 MB `model.onnx` is a pointer file.** The dynamo exporter writes weights
  to an external `.data` sidecar. Parity passes while the sidecar sits next to it,
  then the bundle breaks when moved. The loader now rejects anything under 50 MB.
- **A perfect parity score can be a bug signal.** `0.00000` was first seen from
  exactly that pointer file. Check the file size too.
- **The smoke test cannot detect a destroyed model.** int8 printed `scarcity`
  0.311 where fp32 prints 0.626 — plausible, and completely wrong. Only the parity
  test caught it. int8 is settled: it collapsed all seven dark classes, three
  times. Do not re-litigate it.
- **Reloading the extension does not replace a content script already injected
  into an open tab.** Always open a *fresh* tab when verifying. The zombie script
  reports "Extension context invalidated", which looks like a code bug and is not.
- **A content script is injected once per document, not per navigation.** On an
  SPA an in-page route change replaces the DOM but leaves the script and all its
  state. State must be scoped to a document URL.

## Wording discipline — non-negotiable

Everything user-facing says **"potentially manipulative pattern"**. Never
"illegal", "violation", "fraud", or any claim of unlawfulness. This is enforced in
code for LLM output (`backend/src/app/services/explain.py` rejects generated text
containing legal-claim language), not just requested in a prompt.

Regulatory context (India CCPA 2023, EU DSA) motivates the work. It is never the
basis of a verdict the tool renders.

## Untrusted input

Page text is scraped from third-party sites and is **untrusted**. It reaches an
LLM prompt in `/v1/explain`, where it is fenced and the system prompt names those
blocks as data. Treat any new path that carries page text to a model or a shell
the same way.

## How to work here

- **Measure before patching.** Two ONNX export patches were made on plausible
  reasoning before measuring; both hypotheses were wrong. This repo has a history
  of confident guesses being incorrect — get a real trace or a real number first.
  `make bench`, `make parity`, `make gold-eval`, and the extension's "Download
  debug trace" button exist for this.
- **A rule can be confidently, consistently wrong and pass every test.**
  `stock_counter` matched `"N sold"` as scarcity while `docs/ANNOTATION.md` calls a
  settled sale count benign. Unit tests passed throughout and synthetic metrics
  could not see it; only real pages exposed it, at 44% of all false positives.
  When changing rules, check them against the annotation guide, not just the
  tests.
- **Give a decision with the reason, not a menu of options.**
- **Do not add scope that was not asked for.**
- **Say what is unverified.** Several docs previously carried stale "verified"
  claims; correcting them was real work. Prefer "not measured" over an estimate
  presented as a fact.
- **`docs/` is the record.** Anything learned the hard way goes in
  `docs/PROGRESS.md`; anything measured goes in `docs/RESULTS.md`.

## Current state

All four stages delivered. A 400-snippet real-site evaluation exists, but its
labels were produced by an LLM against `docs/ANNOTATION.md` — a **silver set,
not a gold set**. Real-site figures are preliminary; say so when quoting them. A
human-labelled subset is the highest-value outstanding task.

Measured on that set: macro-F1 **0.394** model-only, **0.717** for the shipped
hybrid, over the 4 of 7 classes that occur in real Daraz pages. Synthetic is
0.9019. Nepali is **unevaluated on real pages** (3 of 400 rows) — the
multilingual claim rests on synthetic data alone.

Also outstanding: inference is ~16x its latency budget (620 ms per batch of 32,
`docs/RESULTS.md` §5) — arithmetic, not a bug; a smaller base model is the only
thing likely to move it materially.

## Where things are

| Doc | For |
|---|---|
| `docs/RESULTS.md` | every measured number |
| `docs/PROGRESS.md` | what was done and why, including what went wrong |
| `docs/ARCHITECTURE.md` | system design and API contract |
| `docs/BACKEND.md` | serving design, invariants, `/v1/explain`, `/v1/traces` |
| `docs/ANNOTATION.md` | labelling rules and the gold/silver-set procedure |
| `docs/model_card.md` | model card, limitations |
