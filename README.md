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
  Browser (MV3 extension)                Backend (FastAPI)
  ┌─────────────────────────┐          ┌───────────────────────┐
  │ content script         │          │ POST /v1/classify    │
  │  • DOM extraction      │   HTTP   │  • LRU cache         │
  │  • MutationObserver    │ ─────►  │  • ONNX int8 model   │
  │  • structural rules    │          │  • per-class thresh. │
  │ side panel + overlay   │ ◄─────  │  • explanations       │
  └─────────────────────────┘          └───────────────────────┘
```

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
| **2** | FastAPI inference service | not started |
| **3** | Chrome extension: extraction, rules, UI | not started |
| **4** | Real-site gold set, evaluation, write-up | not started |

Detail, deliverables and exit criteria per stage: [`docs/STAGES.md`](docs/STAGES.md)

---

## Repository layout

```
dark-pattern-analyzer/
├── docs/                 architecture, stages, setup, results
├── data/
│   ├── synthetic/        27,000-row trilingual dataset
│   ├── generator/        the scripts that produced it (reproducible)
│   └── gold/             hand-annotated real snippets (Stage 4)
├── ml/                   training, evaluation, ONNX export  ← Stage 1
│   ├── notebooks/        Colab fine-tuning notebook
│   ├── src/ml/
│   └── artifacts/        model.onnx, tokenizer, thresholds, metrics
├── backend/              FastAPI service                     ← Stage 2
│   ├── src/app/
│   └── tests/
└── frontend/             WXT + React extension               ← Stage 3
    └── src/
```

`ml/` and `backend/` have **separate dependency sets**. Training needs PyTorch
(~2.5 GB); serving needs only ONNX Runtime (~120 MB). The backend never imports
from `ml/` — the interface between them is the artifact bundle.

---

## Quickstart

```bash
git clone <your-repo-url> dark-pattern-analyzer
cd dark-pattern-analyzer

make install-ml      # training environment
make data-check      # validate the dataset and its leakage guards
make fertility       # compare tokenizers -> decides the base model
```

Then open `ml/notebooks/01_finetune_colab.ipynb` in Google Colab and run it end
to end. Full walkthrough: [`docs/SETUP.md`](docs/SETUP.md)

`make help` lists every target.

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
  "violation" or "fraud".
- Thresholds default to a **precision-favouring** profile. Falsely accusing an
  honest site is worse than missing a pattern.
- Text is hashed for caching; page URLs are stored hashed. No page content leaves
  the machine beyond the snippets sent for classification.
- Scanning is user-initiated.
- Regulatory context (India CCPA 2023 guidelines, EU DSA) motivates the work; it
  is not the basis of any verdict the tool renders.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full system design, API contract, data model, budgets |
| [`docs/STAGES.md`](docs/STAGES.md) | The four stages: deliverables and exit criteria |
| [`docs/PHASES.md`](docs/PHASES.md) | Fine-grained engineering breakdown |
| [`docs/SETUP.md`](docs/SETUP.md) | Colab → VS Code, step by step |
| [`ml/README.md`](ml/README.md) | Training decisions explained |

---

## Reference

Mathur, A., Acar, G., Friedman, M., Lucherini, E., Mayer, J., Chetty, M., &
Narayanan, A. (2019). *Dark Patterns at Scale: Findings from a Crawl of 11K
Shopping Websites.* CSCW.
