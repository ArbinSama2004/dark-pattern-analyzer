# Dark Pattern Analyzer

A multilingual dark pattern detector for e-commerce websites: a fine-tuned
transformer plus a deterministic rule engine, surfaced through a Chrome extension
that analyses live pages in **English, Hindi and Nepali**.

> **Research and educational tool.** It flags *potentially manipulative* interface
> patterns for human review. It does not make legal determinations.

---

## Why this project

Dark patterns are interface designs that steer users toward choices they would not
freely make — fake countdown timers, invented scarcity, guilt-inducing decline
buttons, pre-checked add-ons, deliberately obstructed cancellation.

The reference work in the field (Mathur et al., 2019) surveyed 11,000 shopping
sites in **English only**. South Asian e-commerce is largely absent from that
literature. This project extends the taxonomy to Hindi and Nepali and builds a
working detector, which makes the multilingual gap the contribution rather than a
limitation.

---

## What it detects

| Class | Example |
|---|---|
| `confirmshaming` | "No thanks, I don't like saving money" |
| `false_urgency` | "Offer ends in 09:58" on a timer that resets on reload |
| `forced_action` | "Create an account to view prices" |
| `obstruction` | Cancellation only by phoning during office hours |
| `scarcity` | "Only 2 left in stock!" with no real inventory basis |
| `sneaking` | Pre-checked insurance quietly added at checkout |
| `social_proof` | "37 people are viewing this right now" |
| `benign` | Ordinary, non-manipulative interface text |

**Multi-label by design.** *"Only 3 left — ends in 10:00"* is scarcity **and**
false urgency. Sigmoid outputs with per-class thresholds, never softmax.

---

## Architecture at a glance

```
  Browser (MV3 extension)                 Backend (FastAPI)
  ┌──────────────────────────┐          ┌──────────────────────────┐
  │ content script           │          │ POST /v1/classify        │
  │  • DOM extraction        │   HTTP   │  • LRU cache             │
  │  • MutationObserver      │ ───────► │  • ONNX fp32 MuRIL       │
  │  • 10 structural rules   │ ◄─────── │  • per-class thresholds  │
  │                          │          │                          │
  │ overlay badges           │          │ POST /v1/explain         │
  │ side panel               │ ───────► │  • plain-language why    │
  │  • findings by category  │          │  • via Groq, on demand   │
  │  • click to explain      │          │                          │
  │  • save scan to archive  │ ───────► │ POST /v1/traces          │
  └──────────────────────────┘          │  • MinIO + SQLite index  │
                                        └──────────────────────────┘
```

**fp32, not int8.** int8 quantization was attempted and it destroyed the model —
all seven manipulative classes collapsed to zero positive predictions while the
smoke test kept printing plausible numbers. See
[`docs/RESULTS.md`](docs/RESULTS.md) §4. The cost of that decision is latency: a
batch of 32 takes ~620 ms, not the 40 ms originally budgeted (§5).

**Hybrid, deliberately.** Language models read wording; they cannot see that a
timer resets on reload, that a checkbox ships pre-checked, or that the decline
link is 9px grey on white. Those are structural facts, detected by deterministic
rules in the DOM. Wording classes go to the model. Each layer does what it is
actually good at.

Full design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

---

## Stages

| Stage | Scope | Status |
|---|---|---|
| **1** | Repo structure, dataset, Colab fine-tuning, ONNX artifacts | **delivered** |
| **2** | FastAPI inference service | **delivered**, verified against the real bundle |
| **3** | Chrome extension: extraction, rules, overlay, side panel | **delivered**, verified on live Amazon and Daraz pages |
| **4** | Real-site gold set, evaluation, write-up | **partly done** — see below |

**Stage 4, honestly.** Latency is measured, the evaluation tooling is built, two
things beyond the original plan shipped (LLM explanations, the trace archive), and a
**400-snippet real-site evaluation has been run**.

That evaluation is a **silver set, not a gold set** — the labels were assigned by an
LLM reading `docs/ANNOTATION.md`, because human annotation time was unavailable. It is
blinded (model predictions were withheld from the annotator) but it is not independent
human judgement, and [`docs/RESULTS.md`](docs/RESULTS.md) §6 states exactly what that
does and does not support. Headline results: macro-F1 drops from **0.90 synthetic to
0.39 real** for the model alone, and recovers to **0.717** once a defect the
evaluation exposed in the rule layer was fixed. That defect — one rule contradicting
the project's own annotation guide — was causing the rule layer to *reduce* real-site
accuracy; correcting it moved its contribution from **−0.134 to +0.323** macro-F1
(§7). A human-labelled subset remains the highest-value outstanding task.

Detail, deliverables and exit criteria per stage: [`docs/STAGES.md`](docs/STAGES.md)

---

## Repository layout

```
dark-pattern-analyzer/
├── Makefile              every command; `make help` lists them
├── docker-compose.yml    MinIO, for the trace archive
├── docs/                 architecture, results, progress, annotation rules
├── data/
│   ├── synthetic_v2_1/   28,450-row trilingual dataset (current)
│   ├── generator/        the scripts that produced it (reproducible)
│   └── gold/             hand-annotated real snippets (Stage 4, outstanding)
├── ml/                   training, evaluation, ONNX export  ← Stage 1
│   ├── notebooks/        Colab fine-tuning notebook
│   ├── src/ml/
│   └── artifacts/        model.onnx, tokenizer, thresholds, metrics
├── backend/              FastAPI service                     ← Stage 2
│   ├── src/app/
│   │   ├── api/v1/       classify, explain, traces, health
│   │   ├── core/         taxonomy, model input, bundle loading, hashing
│   │   └── services/     inference, cache, llm, object_store, trace_index
│   ├── scripts/          smoke_check, bench_latency, trace_report, gold_*
│   └── tests/
└── frontend/             WXT + React extension               ← Stage 3
    └── src/
        ├── entrypoints/  content, background, popup, sidepanel
        ├── lib/          extract, rules, api clients, resolve, merge
        └── ui/           shadow-root overlay
```

`ml/` and `backend/` have **separate dependency sets**. Training needs PyTorch
(~2.5 GB); serving needs only ONNX Runtime (~120 MB). The backend never imports
from `ml/` — the interface between them is the artifact bundle.

---

## Quickstart

`make help` lists every target. There are two things you might want to do.

### A. Run the extension (needs the trained bundle)

The bundle (`ml/artifacts/model_v1/model.onnx`, ~950 MB) is gitignored, so a fresh
clone does not have it. Either train it (path B) or copy it in.

```bash
make install-backend      # onnxruntime + fastapi, ~120 MB
make install-frontend     # extension dependencies
make smoke-backend        # verify the bundle: must print scarcity=0.626
```

Then, in **two terminals** — both are long-running:

```bash
make dev                  # backend API on :8000
```

```bash
make ext                  # extension dev build, rebuilds on change
```

Load the extension at `chrome://extensions` → Developer mode → **Load unpacked** →
`frontend/.output/chrome-mv3`.

> **Open a fresh tab afterwards.** Reloading an extension does not replace a content
> script already injected into an open tab, and the resulting zombie script produces
> confusing "Extension context invalidated" errors.

Optional extras, both off by default:

```bash
make minio                # trace archive; then set DP_MINIO_ENABLED=true
```

For LLM explanations, put a [Groq](https://console.groq.com/keys) key in
`backend/.env` as `DP_LLM_API_KEY` and set `DP_LLM_ENABLED=true`. Copy
`backend/.env.example` to `backend/.env` first — every variable is annotated there.

### B. Train the model from scratch

```bash
make install-ml           # torch + transformers, ~2.5 GB
make data-check           # validate the dataset and its leakage guards
make fertility            # compare tokenizers -> decides the base model
```

Then open `ml/notebooks/01_finetune_colab.ipynb` in Google Colab and run it end to
end (~40 minutes on a T4). Full walkthrough: [`docs/SETUP.md`](docs/SETUP.md).

### Checking the work

```bash
make test                 # backend + extension suites
make lint                 # ruff + tsc across all three
make parity               # PyTorch vs ONNX agreement (ml/'s real gate)
make bench                # measure inference latency
```

---

## The dataset

27,000 synthetic snippets, 714 templates, three languages.

| | en | hi | ne |
|---|---|---|---|
| each manipulative class | 1,000 | 1,000 | 1,000 |
| `benign` | 2,000 | 2,000 | 2,000 |

Zero duplicate `(text, lang)` pairs. Ships with two splits:

- **`split_template_disjoint`** — templates held out across train/val/test. **Report this one.**
- **`split_random`** — kept only to quantify the leakage gap (roughly +15 macro-F1).

Because rows are template-generated, a random split puts sibling rows on both
sides and the model scores highly by memorising skeletons. `ml/dataset.py`
hard-asserts template disjointness, so the honest path cannot be missed by
accident.

---

## Model

Base model chosen by evidence, not assumption. `ml/tokenizer_fertility.py`
measures how badly each candidate fragments each language before any training
happens.

| Candidate | Params | Role |
|---|---|---|
| `distilbert-base-multilingual-cased` | 135M | default primary |
| `google/muril-base-cased` | 236M | Indic specialist, pretrained on Nepali |
| `xlm-roberta-base` | 278M | upper-bound reference |
| `Multilingual-MiniLM-L12-H384` | 118M | smallest, for in-browser inference |

If mDistilBERT fragments Nepali more than ~1.5× as badly as MuRIL, MuRIL becomes
primary. Either way the numbers go in the report — Nepali tokenizer coverage is a
legitimate finding.

---

## Honest evaluation

**Headline metric:** macro-F1 across the seven manipulative classes, excluding
`benign` (largest and easiest — including it inflates the number).

Everything in Stages 1–3 is measured on **synthetic data this project generated
itself**. That demonstrates the pipeline works; it does not demonstrate the tool
works on real websites. Stage 4's hand-annotated gold set from live sites is the
only evidence that does.

**Expect the number to drop** — roughly 0.90 synthetic to 0.65–0.75 real. That
drop is the finding. Reporting it with analysis of which classes degrade is
stronger work than presenting a suspiciously clean 0.99.

---

## Ethics

- All output says **"potentially manipulative pattern"** — never "illegal",
  "violation" or "fraud". This is enforced in code, not just in prompts: a
  generated explanation containing legal-claim language is rejected rather than
  shown (`backend/src/app/services/explain.py`).
- Thresholds default to a **precision-favouring** profile. Falsely accusing an
  honest site is worse than missing a pattern.
- Scanning is user-initiated, and can be turned off independently of the overlay.

### Where page content actually goes

Being precise about this matters more than sounding reassuring, so:

| Destination | What is sent | When | Default |
|---|---|---|---|
| Your own backend (`localhost`) | extracted text snippets, with tag and role | on every scan | on |
| **Groq** (third party) | one flagged snippet, plus ~10 neighbouring snippets for context | only when you click "Explain this finding" | **off** |
| **MinIO** (your own storage) | the full extraction trace for one page | only when you click "Save this scan to the archive" | **off** |

The two that leave your machine — or leave the browser — are both opt-in and both
require an explicit click per use rather than a setting flipped once. Page text
sent to Groq is treated as untrusted input: it is fenced, and the system prompt
names those blocks as data, so a page cannot inject instructions into the
explanation. That is a mitigation, not a solved problem.

- Regulatory context (India CCPA 2023 guidelines, EU DSA) motivates the work; it
  is not the basis of any verdict the tool renders.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full system design, API contract, data model, budgets |
| [`docs/RESULTS.md`](docs/RESULTS.md) | **Every measured number**, including the int8 failure and the latency finding |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | What was done and why, stage by stage, including what went wrong |
| [`docs/STAGES.md`](docs/STAGES.md) | The four stages: deliverables and exit criteria |
| [`docs/BACKEND.md`](docs/BACKEND.md) | Serving design, the five invariants, `/v1/explain` and `/v1/traces` |
| [`docs/ANNOTATION.md`](docs/ANNOTATION.md) | Labelling rules, and how to build the gold set |
| [`docs/model_card.md`](docs/model_card.md) | Model card: what it is, what it scores, what it cannot do |
| [`docs/PHASES.md`](docs/PHASES.md) | Fine-grained engineering breakdown |
| [`docs/SETUP.md`](docs/SETUP.md) | Colab → VS Code, step by step |
| [`docs/DATASET_V2.md`](docs/DATASET_V2.md) | Why the dataset was rebuilt, twice |
| [`ml/README.md`](ml/README.md) | Training decisions explained |
| [`backend/README.md`](backend/README.md) | Running the service, configuration |
| [`frontend/README.md`](frontend/README.md) | Extension layout and its two hard constraints |

---

## Reference

Mathur, A., Acar, G., Friedman, M., Lucherini, E., Mayer, J., Chetty, M., &
Narayanan, A. (2019). *Dark Patterns at Scale: Findings from a Crawl of 11K
Shopping Websites.* CSCW.
