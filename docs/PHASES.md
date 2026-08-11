# Dark Pattern Detection — Phase Plan and Implementation Guide

> **Historical planning document.** Counts and scope here describe what was
> planned, not what shipped — e.g. "the eight rules" below became eleven. For
> current behaviour see `DATAFLOW.md` and `ARCHITECTURE.md`.

**Companion to** `ARCHITECTURE.md` · **Version** 1.0

Nine phases, ordered so that **every phase ends with something demonstrable**. If you
run out of time at the end of any phase, you still have a coherent project to submit.

| Phase | Name | Output | Est. |
|---|---|---|---|
| 0 | Ground rules and baseline | Metric harness + logreg baseline | 2–3 days |
| 1 | Model fine-tuning (Colab) | Trained model + metrics | 4–6 days |
| 2 | Artifacts and repo scaffold | Local repo, uv workspace, ONNX | 2–3 days |
| 3 | Inference API | FastAPI + Redis, meeting latency budget | 4–5 days |
| 4 | DOM extraction extension | WXT extension, snippets flowing | 5–7 days |
| 5 | Rule engine | Structural detectors + merge policy | 4–5 days |
| 6 | UI and explanations | Overlay, side panel, page score | 5–6 days |
| 7 | Real gold set and evaluation | **The results chapter** | 5–7 days |
| 8 | Dashboard and write-up | Aggregate view, report, demo | 5–7 days |

**Total ≈ 36–49 working days.** Phases 5, 6 and 8 are the compressible ones. Phase 7 is
not — cutting it removes the only defensible evidence the project works.

---

## Phase 0 — Ground rules and baseline

**Goal:** make the project measurable before making it good.

### Steps

1. Load `dataset_all.csv`. Confirm 27,000 rows, 8 labels, three languages, zero
   duplicate `(text, lang)` pairs.
2. Freeze `label_map.json` — the canonical index→label order — into `packages/dp_core`.
   Every downstream component reads this file. Nothing hardcodes label order.
3. Write `evaluate.py` **now**, before any model exists. It takes predictions plus gold
   labels and prints macro-F1, micro-F1, and a per-class precision/recall/F1 table.
4. Train a TF-IDF (char n-grams 2–5) + one-vs-rest logistic regression baseline.
   Character n-grams matter: they handle Devanagari without any tokenizer work.
5. Record baseline macro-F1 on **both** splits into `metrics.json`.

### Why char n-grams for the baseline

Word-level TF-IDF needs language-specific tokenization and will underperform on Nepali
for uninteresting reasons. Character n-grams sidestep that and give you an honest floor.

### Exit criteria

- [ ] `evaluate.py` runs and prints a per-class table
- [ ] Baseline macro-F1 recorded for random **and** template-disjoint splits
- [ ] The gap between the two splits is written down — this is your overfitting yardstick
- [ ] `label_map.json` committed

> **Expect** the baseline to score ~0.95+ on the random split and noticeably lower on
> template-disjoint. That gap is the single most important number in Phase 0. If the
> transformer later beats the baseline only on the random split, it has learned nothing.

---

## Phase 1 — Model fine-tuning in Colab

**Goal:** a multilingual multi-label classifier that beats the baseline on the
template-disjoint split.

### Step 1.1 — Tokenizer fertility check (do this first, it takes 10 minutes)

For each of `distilbert-base-multilingual-cased`, `google/muril-base-cased`,
`xlm-roberta-base`, compute mean subwords per word on the `ne` and `hi` rows.

**Decision rule:** if mDistilBERT's Nepali fertility is more than ~1.5× MuRIL's, MuRIL
becomes your primary model and mDistilBERT becomes a documented baseline. Make this
call here, on evidence, and write the number in your report. This is a genuine finding,
not a chore.

### Step 1.2 — Data preparation

- Input text is the `model_input` column (`[TAG=button] [ROLE=cancel] <text>`), not raw
  `text`. Add `[TAG=…]`/`[ROLE=…]` as special tokens and resize embeddings.
- Targets: the 8 one-hot columns as a float vector.
- Load `split_template_disjoint/{train,val,test}.csv`. **Do not** re-split.
- Assert zero `template_id` overlap between train and test. Assert it in code; do not
  trust it.

### Step 1.3 — Training configuration

| Hyperparameter | Value | Reason |
|---|---|---|
| Epochs | 3 (early stopping, patience 1) | More epochs memorise templates |
| LR | 3e-5, linear warmup 10% | Standard for DistilBERT-class models |
| Batch size | 32 (64 if VRAM allows) | Colab T4 comfortable |
| Max length | 64 | UI strings are short |
| Loss | `BCEWithLogitsLoss` | Multi-label |
| Weight decay | 0.01 | Mild regularisation |
| Metric for best model | **macro-F1 on val**, not loss | Class-balanced objective |
| Seed | 13, and log it | Reproducibility |

Set `problem_type="multi_label_classification"` on the config so HF wires up BCE and
sigmoid correctly. Getting this wrong yields softmax over 8 classes and silently breaks
multi-label behaviour.

### Step 1.4 — Threshold tuning

For each of the 8 classes independently, sweep thresholds 0.05→0.95 in 0.05 steps on
**val** and keep the one maximising that class's F1. Write `thresholds.json`.

Tune on val. Report on test. Tuning on test invalidates your numbers, and an examiner
will ask.

Also produce a `precision` profile: for each class, the lowest threshold achieving
≥0.85 precision on val. That is the profile the demo runs.

### Step 1.5 — Evaluation

Produce, for all three candidate models:
- macro-F1 and micro-F1 on template-disjoint test
- per-class precision/recall/F1
- **per-language** macro-F1 (en / hi / ne separately) — the interesting result
- confusion analysis on co-occurring pairs, especially scarcity ↔ false_urgency

### Exit criteria

- [ ] Macro-F1 ≥ 0.85 on template-disjoint test
- [ ] Transformer beats the Phase 0 baseline on template-disjoint, not just random
- [ ] Per-language F1 reported; Nepali within ~0.10 of English
- [ ] `thresholds.json`, `metrics.json`, `label_map.json` saved
- [ ] Three-model comparison table complete

### Watch-outs

- **Colab disconnects.** Checkpoint to Google Drive every epoch.
- **Nepali collapse.** If `ne` F1 is far below `en`, it is almost always tokenization,
  not data. Revisit Step 1.1.
- **Suspiciously perfect scores.** ≥0.99 on template-disjoint means leakage. Re-check
  the `template_id` disjointness assertion.

---

## Phase 2 — Artifacts and local repo scaffold

**Goal:** move from notebook to a real, reproducible local project.

### Steps

1. Download from Colab: PyTorch checkpoint, tokenizer, `thresholds.json`,
   `label_map.json`, `metrics.json`.
2. Scaffold the uv workspace:

   ```bash
   uv init dark-pattern-detector && cd dark-pattern-detector
   uv add fastapi uvicorn[standard] pydantic pydantic-settings \
          onnxruntime transformers tokenizers numpy \
          redis asyncpg sqlalchemy[asyncio] alembic
   uv add --dev pytest pytest-asyncio httpx ruff mypy pytest-benchmark
   ```

3. Create `packages/dp_core` and `packages/dp_rules` as workspace members; add them
   with `uv add --editable ./packages/dp_core`.
4. Export ONNX:

   ```bash
   uv run python ml/export_onnx.py \
     --checkpoint ml/artifacts/model_v1/pytorch \
     --out ml/artifacts/model_v1/model.onnx \
     --quantize dynamic-int8 --max-length 64
   ```

5. **Parity test — do not skip.** Run the same 200 validation snippets through the
   PyTorch model and the int8 ONNX model. Assert max absolute logit difference < 0.01
   and identical thresholded labels. Quantization occasionally destroys one class
   quietly; this test is the only thing that catches it.
6. Commit `ruff` + `mypy` config and a pre-commit hook.

### Exit criteria

- [ ] `uv sync` reproduces the environment from scratch
- [ ] `model.onnx` int8 exists, under ~70 MB
- [ ] Parity test passes
- [ ] ONNX inference latency for batch 32 measured and recorded
- [ ] Repo layout matches `ARCHITECTURE.md` §8

---

## Phase 3 — Inference API

**Goal:** `POST /v1/classify` serving batches of 64 inside the latency budget.

### Steps

1. Pydantic v2 schemas from `ARCHITECTURE.md` §5. Enforce `max_items=64` and
   `max_length=200` per snippet at the schema level.
2. Load the ONNX session **once** in the `lifespan` handler. Store it on `app.state`.
3. Implement `services/inference.py`:
   build `model_input` strings from `text`+`tag`+`role` using the same helper as
   training, tokenize as a batch, run ONNX in a threadpool, sigmoid, apply per-class
   thresholds from the active profile.
4. Redis cache: `MGET` all hashes, run only misses, `MSET` results with TTL. Key format
   `dp:v{model_version}:{hash}` — model version in the key, always.
5. `docker-compose.yml` with api + redis + postgres. Alembic migration for the four
   tables.
6. Persist scans/findings asynchronously; the response must not wait on the DB.
7. `pytest-benchmark` gate on the 100 ms budget for batch 32.

### Exit criteria

- [ ] `POST /v1/classify` returns the documented contract
- [ ] Batch of 32 under 100 ms p95, cold cache
- [ ] Cache hit path under 15 ms
- [ ] `/readyz` fails correctly when Redis is down
- [ ] Malformed and oversized payloads rejected with clear 422s
- [ ] Contract tests green

### Watch-outs

- **Feature skew.** If the API builds `model_input` even slightly differently from
  training, accuracy quietly craters. Import one shared function from `dp_core`.
- **Per-request session creation.** Costs 200–500 ms each time. Check this first if
  latency looks wrong.

---

## Phase 4 — DOM extraction extension

**Goal:** real page text reaching the API and predictions coming back.

### Steps

1. `npx wxt@latest init extension` → React + TypeScript. Add Tailwind and shadcn/ui.
2. Content script extractor per `ARCHITECTURE.md` §4.1: `TreeWalker`, skip list,
   shadow-root and same-origin iframe descent, feature capture, candidate filter,
   sha1 hash and dedupe.
3. `MutationObserver` on `document.body`, **debounced 300 ms**.
4. Background service worker: batch 32–64, session cache in
   `chrome.storage.session`, retry with backoff, per-page ceiling of 600 snippets.
5. Generate the TS mirror of `dp_core` (label map, role keywords) as a build step. Never
   hand-copy it.
6. Temporary dev UI: `console.table` of findings. Real UI is Phase 6.
7. Test against **saved local HTML fixtures first**, live sites second.

### Exit criteria

- [ ] Loads unpacked in Chrome without console errors
- [ ] Extracts 100–600 candidates from a real product page
- [ ] Zero duplicate hashes sent per session
- [ ] Countdown timer does **not** cause repeated API calls
- [ ] Predictions returned and logged for at least three real sites
- [ ] Coverage gaps (cross-origin iframes) documented with counts

### Watch-outs

- **MV3 worker termination.** Module-scope state vanishes. Use `chrome.storage.session`.
- **Lazy content.** Infinite-scroll listings need the observer, not a one-shot scan.
- **`innerText` cost.** It forces layout. Read once per element per pass and cache.

---

## Phase 5 — Rule engine

**Goal:** catch the patterns that text alone cannot express.

### Steps

1. Implement the eight rules from `ARCHITECTURE.md` §4.5 in TypeScript (client-side)
   with a Python mirror in `dp_rules` for the report pipeline.
2. Timer detection: a dedicated lightweight observer records whether a node's digits
   change on a ~1 s cadence. Count locally; never emit per tick.
3. Contrast: implement the WCAG relative-luminance ratio properly. Resolve the
   effective background by walking ancestors until a non-transparent background is
   found.
4. Checkout-step heuristic (`product` / `cart` / `payment`) from URL and heading
   keywords per language. `late_fee` depends on it.
5. Implement the merge policy, including `source` provenance on every label.
6. Unit-test every rule against saved HTML fixtures with known expected hits.

### Exit criteria

- [ ] All eight rules implemented with fixture tests
- [ ] Provenance (`rule` / `model` / both) present on every finding
- [ ] Ablation measured: macro-F1 with rules vs model-only on the gold set
- [ ] Rule-vs-model agreement rate logged

> The ablation number is a real contribution. "Rules add +0.08 macro-F1 over the model
> alone, concentrated in false_urgency and sneaking" is exactly the kind of claim that
> makes a project chapter worth reading.

---

## Phase 6 — UI and explanations

**Goal:** make the findings legible and defensible to a non-technical user.

### Steps

1. Overlay in a **closed shadow root** with `all: initial`. Badges positioned via
   `getBoundingClientRect()`, repositioned on scroll/resize.
2. Side panel: findings grouped by category; each row shows category, confidence band,
   snippet, plain-language *why*, and click-to-scroll-and-highlight.
3. Explanation strings: one short template per class per language, stored in
   `dp_core`. Not model-generated — you need them stable and reviewable.
4. Page score: publish the weighted formula in an info tooltip. Bucket low/medium/high.
5. Feedback controls wired to `POST /v1/feedback`. This feeds Phase 7.
6. Accessibility: keyboard navigable panel, ARIA labels, and a global off switch.

### Exit criteria

- [ ] Overlay never breaks host page layout (verified on 5+ sites)
- [ ] Every finding has a human-readable explanation in all three languages
- [ ] Page score formula visible in the UI
- [ ] Feedback round-trips to the database
- [ ] All UI copy uses "potentially manipulative", never "illegal"

---

## Phase 7 — Real gold set and evaluation

**This is the phase that makes the project defensible. Do not compress it.**

### Steps

1. Choose 10–15 real sites with a Nepal/India focus: Daraz, SastoDeal, Gyapu,
   HamroBazar, Flipkart, Meesho, Myntra, plus a few global controls.
2. Save the HTML of each page into `tests/fixtures/pages/`. Sites change; your evidence
   must not.
3. Extract snippets with your own extension and sample **300–500** for annotation,
   stratified so each class has representation.
4. Annotate against `ANNOTATION_GUIDE.md` (the boundary rules in `ARCHITECTURE.md` §2.2).
   Get a second annotator for at least 100 items and compute **Cohen's κ**. If κ < 0.6,
   your definitions are ambiguous — fix the guide and re-annotate, don't average it away.
5. Evaluate the model on this gold set. **These are your headline numbers.**
6. Report the synthetic→real gap explicitly, per class and per language.
7. Error analysis: sample 30 false positives and 30 false negatives, categorise the
   failure modes, and write them up.
8. If gold macro-F1 < 0.70: fine-tune for 1–2 epochs on synthetic + gold combined
   (gold upweighted), holding out a gold test portion. Re-report both numbers.

### Exit criteria

- [ ] 300+ annotated real snippets committed
- [ ] Cohen's κ ≥ 0.6 reported
- [ ] Gold-set macro-F1 ≥ 0.70, per-class and per-language tables complete
- [ ] Synthetic→real gap quantified and discussed
- [ ] Error analysis with categorised failure modes written

> **The most likely outcome:** synthetic test F1 near 0.90, real gold F1 near 0.65–0.75.
> That drop is not a failure — it is the finding. Reporting it honestly, with analysis
> of *why*, is stronger work than a suspiciously clean 0.99.

---

## Phase 8 — Dashboard and write-up

**Goal:** turn the tool into a study.

### Steps

1. Next.js dashboard reading from Postgres: prevalence by category, by site, by
   language; most-flagged sites; category co-occurrence heatmap.
2. Run your extension across the 10–15 sites and record aggregate prevalence — a small
   replication of Mathur et al. on Nepali and Indian e-commerce. **This is the paper
   angle.**
3. Write the model card: training data, synthetic caveat, per-language limits, intended
   use, out-of-scope use.
4. Final report structure: Introduction → Related work (Mathur et al., CCPA 2023, DSA) →
   Taxonomy → Dataset (synthetic generation *and* its limits) → Method (hybrid) →
   Results (both splits + gold + ablation) → Discussion → Limitations → Future work.
5. Demo: a recorded run plus saved fixtures as a fallback. Never demo live-only.

### Exit criteria

- [ ] Dashboard shows cross-site prevalence per category and language
- [ ] Model card written
- [ ] Report complete with all results tables
- [ ] Demo recorded and fixture-backed
- [ ] Limitations section explicitly covers synthetic data and iframe coverage

---

## Cross-phase discipline

### Definition of done, every phase

1. Code is `ruff`-clean and type-checked
2. Tests exist and pass
3. A number was measured and written down
4. `docs/` updated if a decision changed
5. Tagged commit (`phase-3-complete`)

### The four things that most often go wrong

1. **Feature skew** between training and serving input construction → one shared
   function in `dp_core`, imported by both.
2. **Label order drift** → `label_map.json`, read by everything, hardcoded nowhere.
3. **Threshold drift** → `thresholds.json` ships as a model artifact, never as code
   constants.
4. **Evaluating on the random split** → report template-disjoint and gold only.

### If you fall behind

Cut in this order:

1. Dashboard (Phase 8, step 1–2)
2. Nepali *or* Hindi — ship two languages well rather than three badly
3. Rules 5–8, keeping `countdown_timer`, `stock_counter`, `viewer_counter`,
   `prechecked_optin`
4. Postgres persistence, keeping Redis

**Never cut:** Phase 7. A working extension with no honest evaluation is a demo, not a
major project.
