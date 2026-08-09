# Implementation Stages

**Companion to** `ARCHITECTURE.md` (the design) and `PHASES.md` (the detailed
engineering breakdown). This file is the **delivery plan**: four stages, each one a
self-contained unit of work that ends with something runnable.

`PHASES.md` describes *nine* engineering phases. That document is the reference for
*how* each piece of work is done and what its exit criteria are. This document groups
those phases into **four implementation stages** — the units in which the project is
actually built, reviewed and committed.

---

## Stage map

| Stage | Name | Covers phases | Ends with |
|---|---|---|---|
| **1** | Foundation and Model | 0, 1, 2 | A trained model and its artifacts on your machine |
| **2** | Backend | 3 | A running API that classifies text over HTTP |
| **3** | Frontend | 4, 5, 6 | A working Chrome extension flagging patterns on live pages |
| **4** | Evaluation and Release | 7, 8 | Honest metrics, docs, demo, and a repo that reads well |

Each stage is independently demonstrable. If the project stopped at the end of any
stage, what exists would still be coherent and presentable.

---

## Stage 1 — Foundation and Model

> **Status:** delivered

**Goal:** everything needed to produce a trained multilingual classifier, plus the
repository it will live in.

### Delivered

| Item | Location |
|---|---|
| Repository structure | whole tree |
| Architecture and design docs | `docs/ARCHITECTURE.md`, `docs/PHASES.md`, this file |
| Colab → VS Code handover guide | `docs/SETUP.md` |
| Trilingual dataset, 27,000 rows | `data/synthetic/` |
| Dataset generator (reproducibility) | `data/generator/` |
| Colab fine-tuning notebook | `ml/notebooks/01_finetune_colab.ipynb` |
| Training and evaluation code | `ml/src/ml/` |
| ONNX export + quantization + parity check | `ml/src/ml/export_onnx.py`, `parity_test.py` |

### The work, in order

1. **`uv sync` in `ml/`** — confirm the environment builds.
2. **Upload `ml/` and `data/synthetic/` to Colab** (or clone the repo there). See
   `docs/SETUP.md`.
3. **Run the tokenizer fertility check.** This is the first cell of substance in the
   notebook and it decides your base model on evidence rather than assumption. Record
   the numbers — they belong in your report.
4. **Train the baseline** (TF-IDF char n-grams + logistic regression). Cheap, and it is
   the floor every later number is compared against.
5. **Fine-tune** the chosen transformer on the **template-disjoint** split.
6. **Tune per-class thresholds** on validation.
7. **Evaluate** on the template-disjoint test split: macro-F1, per-class, and
   per-language.
8. **Export to ONNX**, quantize to int8, and **run the parity test**.
9. **Download the artifact bundle** into `ml/artifacts/model_v1/`.

### Exit criteria

- [ ] Fertility numbers recorded for all three candidate base models
- [ ] Base model chosen, with the reason written down
- [ ] Baseline macro-F1 recorded on both splits
- [ ] Fine-tuned macro-F1 ≥ 0.85 on template-disjoint test
- [ ] Transformer beats the baseline **on template-disjoint**, not just on random
- [ ] Per-language F1 reported; Nepali within ~0.10 of English
- [ ] `model.onnx` (int8), `tokenizer/`, `thresholds.json`, `label_map.json`,
      `metrics.json` present in `ml/artifacts/model_v1/`
- [ ] Parity test passes: PyTorch and ONNX agree on labels for 200 validation rows

### Why this ordering

The fertility check comes before training because it can change which model you train.
The baseline comes before the transformer because without it you cannot claim the
transformer helped. The parity test comes before Stage 2 because int8 quantization
occasionally destroys one class silently, and you do not want to discover that while
debugging the API.

---

## Stage 2 — Backend

> **Status:** code complete; inference unverified against the real model bundle
> (see `HANDOFF_VERIFIED.md`)

**Goal:** a FastAPI service that loads the Stage 1 artifacts and classifies batches of
snippets inside the latency budget.

### To deliver

| Item | Location |
|---|---|
| Shared truth: taxonomy, frozen label order, input builder | `backend/src/app/core/` |
| Request/response contracts | `backend/src/app/schemas/` |
| `POST /v1/classify`, `GET /healthz`, `GET /readyz` | `backend/src/app/api/v1/` |
| ONNX inference service | `backend/src/app/services/inference.py` |
| In-memory LRU cache behind a swappable interface | `backend/src/app/services/cache.py` |
| Tests, including a feature-skew guard | `backend/tests/` |
| Container image | `backend/Dockerfile` |

### Key constraints

- The ONNX session is created **once**, in the FastAPI `lifespan` handler. Creating it
  per request costs 200–500 ms and is the most common cause of a blown latency budget.
- The API must build its model input string using **the same code** as training. This is
  what `core/model_input.py` is for, and `tests/test_model_input.py` guards it. Feature
  skew between training and serving is silent and devastating.
- Per-class thresholds are **loaded from `thresholds.json`**, never hardcoded.
- Inference runs in a threadpool so it does not block the event loop.

### Exit criteria

- [ ] `POST /v1/classify` matches the contract in `ARCHITECTURE.md` §5
- [ ] Batch of 32 classified in under 100 ms p95, cold cache
- [ ] Cache hit path under 15 ms
- [ ] `/readyz` correctly reports not-ready when artifacts are missing
- [ ] Oversized and malformed payloads rejected with clear 422s
- [ ] Feature-skew test green

---

## Stage 3 — Frontend

> **Status:** code complete and wired end-to-end (popup, side panel, content
> script, background, messaging); not yet verified with a real Chrome
> load-unpacked test against a live backend (see `HANDOFF_VERIFIED.md`)

**Goal:** a Chrome extension that extracts real DOM content, applies structural rules
locally, calls the backend, and presents findings legibly.

### To deliver

| Item | Location |
|---|---|
| DOM extractor: TreeWalker, shadow DOM, same-origin iframes | `frontend/src/lib/extract/` |
| Debounced `MutationObserver` | `frontend/src/entrypoints/content.ts` |
| Batching, dedupe, retry, session cache | `frontend/src/entrypoints/background.ts` |
| Eight deterministic rules | `frontend/src/lib/rules/` |
| Overlay badges in an isolated shadow root | `frontend/src/ui/` |
| Side panel: grouped findings, page score, explanations | `frontend/src/entrypoints/sidepanel/` |

### Key constraints

- **Debounce the observer at ~300 ms.** Countdown timers mutate every second; an
  undebounced observer will flood your own API.
- Timer detection is the deliberate exception: a small dedicated observer watches whether
  digits change on a ~1 s cadence. That counting happens **locally** and is never sent
  per tick.
- The overlay lives in a **closed shadow root** with `all: initial`, so host page CSS
  cannot break it and its styles cannot break the host page.
- MV3 service workers are terminated aggressively. Session state goes in
  `chrome.storage.session`, not module scope.
- Rules run client-side because they need computed styles, mutation cadence and
  checkbox state — none of which survive a trip to the server.

### Exit criteria

- [ ] Loads unpacked in Chrome with no console errors
- [ ] Extracts 100–600 candidates from a real product page
- [ ] Zero duplicate snippets sent per session
- [ ] A countdown timer does **not** trigger repeated API calls
- [ ] Overlay never disturbs host page layout, verified on 5+ sites
- [ ] Every finding shows a plain-language explanation in the page's language
- [ ] All user-facing copy says "potentially manipulative", never "illegal"

---

## Stage 4 — Evaluation and Release

> **Status:** not started

**Goal:** turn a working tool into defensible work.

### To deliver

| Item | Location |
|---|---|
| Saved HTML of 10–15 real sites | `backend/tests/fixtures/pages/` |
| 300–500 hand-annotated real snippets | `data/gold/` |
| Annotation guide | `docs/ANNOTATION_GUIDE.md` |
| Gold-set evaluation, per class and per language | `docs/RESULTS.md` |
| Rule-layer ablation | `docs/RESULTS.md` |
| Model card | `docs/model_card.md` |
| Final README, demo recording | root |

### Why this stage is not optional

Everything before it is measured on **synthetic** data that this project generated
itself. Those numbers demonstrate that the pipeline works; they do not demonstrate that
the tool works on real websites. The gold set is the only evidence that does.

The expected result is a visible drop — synthetic test macro-F1 near 0.90, real gold
near 0.65–0.75. **That drop is the finding, not a failure.** Reporting it with analysis
of which classes degrade and why is stronger work than presenting a suspiciously clean
0.99.

### Exit criteria

- [ ] 300+ annotated real snippets committed
- [ ] Inter-annotator agreement (Cohen's κ) reported for a 100-item overlap
- [ ] Gold-set macro-F1 ≥ 0.70, with per-class and per-language tables
- [ ] Synthetic → real gap quantified and discussed
- [ ] Rule ablation measured: macro-F1 with rules vs model alone
- [ ] Error analysis: 30 false positives and 30 false negatives categorised
- [ ] Model card written, including the synthetic-data caveat
- [ ] Demo recorded and backed by saved fixtures, never live-only

---

## Deferred by design

These are intentionally absent from the current tree. Each has a documented trigger.
This is a plan, not technical debt.

| Deferred | Returns in | Trigger |
|---|---|---|
| Redis cache | Stage 2 hardening | Cross-session cache misses become measurable |
| Postgres, migrations, `db/` | Stage 4 | You begin collecting the gold set at volume |
| `POST /v1/feedback` | Stage 4 | Depends on the database |
| Python mirror of the rule engine | Stage 4 | Offline batch scoring of saved HTML |
| `GET /v1/rules` | Stage 3 (late) | Rule updates without rebuilding the extension |
| `docker-compose.yml` | With Redis | Nothing to orchestrate until then |
| Next.js aggregate dashboard | Stage 4, optional | First thing to cut under time pressure |

---

## Non-negotiables across all stages

1. **Label order is frozen** in `label_map.json` and read from there by every component.
   Hardcoded label lists are how predictions become silently wrong.
2. **Thresholds ship as an artifact**, never as code constants.
3. **Model input is built by one function**, shared between training and serving.
4. **Report template-disjoint and gold metrics only.** The random split overstates
   performance by roughly 15 F1 points because it lets the model memorise phrasings.
5. **Language discipline.** "Potentially manipulative pattern." Never "illegal",
   "violation", or "fraud". Regulatory context (India CCPA 2023, EU DSA) belongs in
   motivation and related work, not in verdicts the tool renders.
