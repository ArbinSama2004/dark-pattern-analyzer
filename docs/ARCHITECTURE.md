# Dark Pattern Detection on E-Commerce Websites
## System Architecture

**Version** 1.0 · **Status** Design baseline · **Owner** Prensu Dangol

---

## 1. Purpose

A browser extension that scans a live e-commerce page, extracts candidate UI text and
structural signals from the DOM, and flags **potentially manipulative design patterns**
(dark patterns) across eight categories in **English, Hindi and Nepali**.

Detection is **hybrid**: a fine-tuned multilingual transformer handles wording-based
patterns, and a deterministic rule engine handles structural patterns that text alone
cannot capture (countdown timers, pre-checked boxes, hidden opt-outs).

### 1.1 Success criteria

| Dimension | Target |
|---|---|
| Macro-F1 on template-disjoint synthetic test | ≥ 0.85 |
| Macro-F1 on hand-annotated real-site gold set | ≥ 0.70 |
| Precision on each dark class (real gold set) | ≥ 0.75 (precision-favoured) |
| End-to-end latency, batch of 32 snippets | < 100 ms server-side |
| Languages supported | en, hi, ne |

### 1.2 Non-goals

- Not a legal compliance tool. Output is always phrased as *"potentially manipulative
  pattern"*, never *"illegal"* or *"violation"*.
- No automated crawling of sites at scale. Scanning is **user-initiated** on pages the
  user is already visiting.
- No account/credential interaction, no form submission, no purchase automation.
- No PII collection. Snippet text is hashed for caching; raw text is not persisted by
  default.

---

## 2. Taxonomy and label contract

Eight labels. Seven dark classes plus one **benign** negative class. Derived from
Mathur et al. (2019), with `confirmshaming` broken out as its own class rather than
folded into *misdirection*.

| Label | Definition | Canonical example |
|---|---|---|
| `false_urgency` | Fabricated or unverifiable time pressure | "Sale ends in 09:58" |
| `scarcity` | Fabricated or unverifiable limited supply | "Only 2 left in stock" |
| `social_proof` | Unverifiable claims about others' behaviour | "37 people are viewing this" |
| `confirmshaming` | Guilt/shame wording on the decline option | "No thanks, I hate saving money" |
| `forced_action` | Requiring an unrelated action to proceed | "Sign up to see the price" |
| `obstruction` | Making a desired action needlessly hard | "To cancel, call our helpline" |
| `sneaking` | Costs/items added or revealed late | "Rs. 149 service fee added" |
| `benign` | Ordinary, non-manipulative UI text | "Add to cart", "Delivery in 3 days" |

### 2.1 Multi-label, not multi-class

A single string can exhibit two patterns simultaneously:

> "Only 3 left — offer ends in 10:00" → `scarcity` **and** `false_urgency`

**Contract:**
- Loss: `BCEWithLogitsLoss` over 8 independent sigmoid outputs.
- `benign` is a real trainable label, not "all zeros". An all-zeros prediction is
  treated as *abstain*, which is distinct from *confidently benign*.
- Per-class decision thresholds, tuned on the validation split, not a global 0.5.

### 2.2 Boundary rules (annotation guide)

These must be applied consistently when building the real gold set, or your labels will
fight the synthetic data.

1. **Verifiable ≠ dark.** "Only 2 left" is `scarcity` only if the count is
   unverifiable or known-fabricated. A real inventory count is `benign`. When you
   cannot tell from the page alone, label by *presentation*: pulsing red text with a
   ticking number is dark; a static grey stock line is benign.
2. **Neutral decline ≠ confirmshaming.** "No thanks" is `benign`. "No thanks, I don't
   want to save money" is `confirmshaming`. The shame must be in the wording.
3. **Disclosed fee ≠ sneaking.** A fee shown on the product page is `benign`. The same
   fee first appearing at the payment step is `sneaking`. Position in the flow matters,
   which is why the extension records step context.
4. **Legitimate support routing ≠ obstruction.** "Contact support" is `benign`.
   "Cancellation is only possible by phone" is `obstruction`. Asymmetry between how easy
   it is to subscribe vs unsubscribe is the tell.
5. **Prefer precision.** When genuinely ambiguous, label `benign`. A false accusation is
   more costly than a miss for this project's framing.

---

## 3. System overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ BROWSER (Chrome / Edge, Manifest V3)                                   │
│                                                                        │
│  ┌──────────────────────┐      ┌───────────────────────────────────┐   │
│  │ Content Script       │      │ Overlay UI (Shadow DOM isolated)  │   │
│  │  · MutationObserver  │      │  · badges pinned to elements      │   │
│  │  · DOM extractor     │─────▶│  · "why?" tooltip                 │   │
│  │  · shadow/iframe walk│      │  · non-invasive, toggleable       │   │
│  │  · hash + dedupe     │      └───────────────────────────────────┘   │
│  │  · local rule engine │                                             │
│  └──────────┬───────────┘      ┌───────────────────────────────────┐   │
│             │                  │ Side Panel                        │   │
│             │                  │  · findings grouped by category   │   │
│             │                  │  · click → scroll + highlight     │   │
│             │                  │  · page dark-pattern score        │   │
│             │                  └───────────────────────────────────┘   │
│  ┌──────────▼───────────┐                                              │
│  │ Background Service   │  batching · retry · session cache            │
│  │ Worker               │                                              │
│  └──────────┬───────────┘                                              │
└─────────────┼──────────────────────────────────────────────────────────┘
              │ HTTPS  POST /v1/classify   (batches of 32–64)
┌─────────────▼──────────────────────────────────────────────────────────┐
│ BACKEND  (Python 3.12 · uv · FastAPI · uvicorn)                        │
│                                                                        │
│  Router ─▶ Validation (Pydantic v2) ─▶ Cache lookup (Redis)            │
│                                          │ miss                        │
│                                          ▼                             │
│                            Preprocessor (context tokens)               │
│                                          ▼                             │
│                        ONNX Runtime · int8 quantized model              │
│                                          ▼                             │
│                     Per-class thresholds ─▶ Rule merge                  │
│                                          ▼                             │
│                        Response  +  async persist (Postgres)            │
└────────────────────────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────────────────┐
│ DATA / ANALYTICS                                                       │
│  Postgres: scans, findings, feedback, model_registry                   │
│  Optional Next.js dashboard: cross-site aggregate statistics           │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Component design

> **The `/v1/classify` JSON shown in this document is illustrative, not the
> implemented contract.** The shipped request is `{snippets:[{text, tag, role,
> lang, ref}]}` and the response is `{results:[{snippet_id, ref, findings,
> benign, benign_score, scores, cached}], meta}`; the page score is computed
> client-side, not returned. `backend/src/app/schemas/classify.py` is the
> source of truth, and `frontend/src/lib/api/classify.ts` mirrors it.

### 4.1 Extension — content script

> Step-by-step data flow, including the duplicate collapse and the field-inference
> layer added on 2026-08-11, is in [DATAFLOW.md](DATAFLOW.md). This section stays
> the design rationale.

**Responsibility:** turn a live DOM into a clean, deduplicated list of classification
candidates plus structural signals.

**Extraction algorithm**

1. Walk the document with `TreeWalker` (`NodeFilter.SHOW_ELEMENT`).
2. **Skip** `script`, `style`, `noscript`, `svg`, `head`, `template`, and any element
   with `aria-hidden="true"`.
3. **Descend into** open shadow roots (`el.shadowRoot`) and same-origin iframes.
   Cross-origin iframes are unreachable by design — log as a coverage gap.
4. For each candidate element capture:

   | Field | Source | Used by |
   |---|---|---|
   | `text` | `innerText`, trimmed, collapsed whitespace, capped at 200 chars | model |
   | `tag` | `tagName.toLowerCase()` | model + rules |
   | `role` | inferred: one of the 20 roles the model was trained on (`decline`, `cta`, `checkbox`, `banner`, `label`, `body`, `fine_print`, `timer`, `stock`, `line_item`, `nav`, `form`, `form_gate`, `heading`, `help_text`, `modal_text`, `promo`, `support_link`, `toast`, `badge` -- see `data/synthetic/dataset_all.csv`'s `role` column, the actual source of truth) | model + rules |
   | `visible` | `offsetParent !== null` && computed `visibility`/`opacity`/`display` | rules |
   | `font_px` | `getComputedStyle().fontSize` | rules |
   | `contrast` | WCAG ratio of colour vs background | rules |
   | `checked` | `input.checked` for checkbox/radio | rules |
   | `is_animated` | digits changing across observer ticks | rules |
   | `step` | checkout stage heuristic: `product` \| `cart` \| `payment` | sneaking |
   | `selector` | stable CSS path, for later highlight | overlay |

5. **Candidate filter** (cheap, before any network call): drop empty strings, strings
   under 3 characters, pure numbers, and text longer than 200 chars (article body, not
   UI chrome).
6. **Hash and dedupe:** two deliberately different ids, not one (`frontend/src/lib/hash.ts`).
   `occurrenceId = sha1(lang + NUL + selector + NUL + text)` is `candidate.id` --
   unique per *DOM occurrence*, so three separate "Add to Cart" buttons on a listing
   page are three independently addressable candidates, never collapsed into one.
   `modelCacheKey = sha1(lang + NUL + tag + NUL + role + NUL + text)` is what the
   extension's own session cache is keyed by -- distinct occurrences with identical
   model input are still allowed to share one cached result. Never send a model input
   the session cache has already resolved; never use `occurrenceId` as that cache
   key, or every repeated control pays for its own forward pass.

**Change detection**

- Single `MutationObserver` on `document.body` with
  `{ childList: true, subtree: true, characterData: true, attributes: true,
     attributeFilter: ["class", "style", "checked", "hidden"] }`.
- **Debounce 300 ms.** Countdown timers mutate every second; without debouncing you
  will DoS your own API.
- Timer detection is the exception that *wants* the mutation firehose: a small
  dedicated observer records whether a node's digits change on a ~1 s cadence, which is
  the `is_animated` signal. This is counted locally and never sent per-tick.

**Role inference** is a small ordered heuristic — accessible name, then `aria-label`,
then text match against a per-language keyword table (`cancel` / `रद्द` / `रद्द गर्नुहोस्`),
then position relative to the primary CTA. Keep it in `packages/dp_core` so the same
table serves the extension and the backend.

### 4.2 Extension — background service worker

- Batches candidates into groups of **32–64**.
- Maintains a session-scoped `Map<hash, result>` so re-renders cost nothing.
- Retries with exponential backoff (250 ms → 2 s, 3 attempts).
- Enforces a per-page ceiling (e.g. 600 snippets) so a pathological page cannot hang
  the run.
- MV3 service workers are killed aggressively; persist the session cache to
  `chrome.storage.session`, not module scope.

### 4.3 Extension — overlay and side panel

- Overlay renders inside a **closed shadow root** with `all: initial` so host-page CSS
  cannot break it and your styles cannot break the host page.
- Badge per finding, positioned with `getBoundingClientRect()`, repositioned on scroll
  and resize via `ResizeObserver`.
- **Badge placement** scores several candidate positions (above / below / beside the
  target, each viewport-clamped) against the rectangles of rendered page *text*
  collected via `Range.getClientRects()`, and picks the one covering least. Badges are
  measured after being attached rather than assumed to be a fixed size. When no
  position is clean, the badge collapses to an icon-only form that expands on hover —
  the labelled form is kept wherever there is genuinely room for it. See
  `chooseBadgePosition` in `frontend/src/ui/overlay.ts`.
- Side panel (Chrome Side Panel API) lists findings grouped by category, each with:
  category name, confidence band (`likely` / `possible`), the matched snippet, a
  plain-language *why*, and a click-to-scroll-and-highlight action. Clicking a finding
  expands a detail view (evidence provenance, matched text, element/role, model score
  where applicable). The panel opens from the toolbar icon by default; which *side*
  Chrome renders it on is a browser-level user preference, not settable by the
  extension.
- **Settings** (`frontend/src/lib/settings.ts`) live in `chrome.storage.local` so they
  survive a browser restart. Scanning and overlay display are separate switches:
  hiding badges is instant and keeps findings accumulating, whereas re-enabling
  scanning costs a full re-scan.
- **Page score:** weighted count of findings, normalised to 0–100 and bucketed
  low/medium/high. Publish the formula in the UI — an unexplained score is not
  defensible in a report.
- Every finding carries a thumbs up/down control feeding `POST /v1/feedback`. This is
  how you grow the real gold set for free while demoing.

### 4.4 Backend — FastAPI service

```
apps/api/
  main.py            # app factory, CORS, lifespan
  routers/
    classify.py      # POST /v1/classify
    feedback.py      # POST /v1/feedback
    rules.py         # GET  /v1/rules      (rule table, versioned)
    health.py        # GET  /healthz /readyz
  services/
    inference.py     # ONNX session, batching, thresholds
    cache.py         # Redis get/set-many
    persistence.py   # async writes
  schemas/           # Pydantic v2 request/response models
  settings.py        # pydantic-settings, env-driven
```

**Design rules**

- The ONNX session is created **once** in the FastAPI `lifespan` handler and reused.
  Creating it per request is the single most common way to destroy your latency target.
- Inference is CPU-bound. Run it in a thread via `run_in_threadpool` (or
  `asyncio.to_thread`) so it does not block the event loop.
- Cache and DB writes are `asyncio.gather`-ed; the DB write is fire-and-forget relative
  to the response.
- Redis key: `dp:v{model_version}:{hash}`. **Include the model version in the key** —
  otherwise a model upgrade silently serves stale predictions forever.

### 4.5 Rule engine (`packages/dp_rules`)

Deterministic detectors run **client-side** where possible (zero latency, no data sent)
and are mirrored server-side for the report pipeline.

| Rule | Signal | Emits |
|---|---|---|
| `countdown_timer` | digits in node change on ~1 s cadence | `false_urgency` |
| `stock_counter` | regex `only\s+\d+\s+left` per language, or count decrementing | `scarcity` |
| `viewer_counter` | regex `\d+\s+(people\|viewing\|watching)` + value churn | `social_proof` |
| `prechecked_optin` | `input[type=checkbox][checked]` whose label mentions email/SMS/newsletter | `sneaking` |
| `hidden_optout` | `font_px < 11` or `contrast < 3.0` or `opacity < 0.6` on a decline control | `sneaking`, `obstruction` |
| `cta_asymmetry` | accept button area ÷ decline button area > 3 | `obstruction` |
| `late_fee` | new price line appears at `step=payment` absent at `step=cart` | `sneaking` |
| `cancel_offsite` | cancel/unsubscribe link routes to phone/email/external | `obstruction` |

**Merge policy** when a rule and the model disagree on the same snippet:

1. Rule hit + model hit → confidence `likely`, `source: ["rule","model"]`.
2. Rule hit only → `likely`. Structural evidence is stronger than wording; a timer *is*
   a timer.
3. Model hit only → `possible`.
4. Rules never suppress model output and vice versa; both are reported with provenance.
   Provenance is what makes your evaluation chapter writable — you can ablate the rule
   layer and report the delta.

### 4.6 Model

| Aspect | Decision |
|---|---|
| Primary base | `distilbert-base-multilingual-cased` (135M) |
| Indic comparison | `google/muril-base-cased` (236M) — covers Nepali explicitly |
| Upper bound | `xlm-roberta-base` (278M) |
| In-browser candidate | `Multilingual-MiniLM-L12-H384` (118M) |
| Head | Linear → 8 logits, sigmoid |
| Loss | `BCEWithLogitsLoss`, optional `pos_weight` for benign imbalance |
| Max length | 64 tokens (UI strings are short; 128 wastes compute) |
| Input format | `[TAG=button] [ROLE=cancel] <text>` |
| Serving | ONNX Runtime, dynamic int8 quantization |

**Never** use `distilbert-base-uncased`. Its vocabulary will shred Devanagari into
near-useless subwords. Measure **tokenizer fertility** (mean subwords per word) on the
`ne` rows for all three candidates before committing — if mDistilBERT fragments Nepali
badly and MuRIL does not, MuRIL becomes primary and the "DistilBERT" framing becomes a
baseline instead of the headline.

**Artifacts produced by training:**

```
model_v{N}/
  model.onnx              # int8 quantized
  tokenizer/              # tokenizer.json, vocab, config
  thresholds.json         # per-class decision thresholds from val
  label_map.json          # index → label, frozen order
  metrics.json            # macro-F1, per-class P/R/F1, both splits
  card.md                 # model card: data, limits, intended use
```

`label_map.json` freezing the label order is not optional. If the order drifts between
training and serving, every prediction is silently wrong and nothing crashes.

---

## 5. API contract

### `POST /v1/classify`

```json
{
  "page": { "host": "daraz.com.np", "lang": "ne", "step": "cart" },
  "items": [
    {
      "id": "a3f9c1e0",
      "text": "केवल २ बाँकी",
      "tag": "span",
      "role": "banner",
      "visible": true,
      "font_px": 13,
      "contrast": 4.8,
      "checked": null,
      "is_animated": false
    }
  ],
  "options": { "profile": "precision", "return_scores": true }
}
```

```json
{
  "model": { "name": "mdistilbert-dp", "version": "1.2.0", "profile": "precision" },
  "results": [
    {
      "id": "a3f9c1e0",
      "labels": [
        { "label": "scarcity", "score": 0.94, "confidence": "likely",
          "source": ["model", "rule:stock_counter"] }
      ],
      "explanation": "Claims a low stock count that the page does not substantiate."
    }
  ],
  "page_score": { "value": 61, "band": "medium" },
  "stats": { "cached": 12, "computed": 20, "latency_ms": 47 }
}
```

**Conventions**
- Version in the path (`/v1/`). Model version in the body, never the path.
- `id` is client-generated so the extension can reconcile out-of-order responses.
- `profile` selects a threshold set: `precision` (demo default), `balanced`, `recall`.
- Unknown fields are ignored, never rejected — the extension will ship ahead of the API.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `POST /v1/feedback` | `{ id, text_hash, predicted, corrected, host }` → gold-set growth |
| `GET /v1/rules` | Versioned rule table so the extension can sync without a rebuild |
| `GET /healthz` | Liveness |
| `GET /readyz` | Readiness: ONNX session loaded, Redis reachable |

---

## 6. Persistence

```sql
-- one row per user-initiated page scan
scans(id, host, url_hash, lang, step, started_at, snippet_count,
      page_score, model_version)

-- one row per detected pattern
findings(id, scan_id → scans, label, score, confidence,
         sources text[], tag, role, selector, text_hash, created_at)

-- raw text, only for snippets the user explicitly reports
snippets(text_hash PK, text, lang, first_seen_at)

-- human corrections → your real gold set
feedback(id, text_hash, predicted text[], corrected text[], host, created_at)

-- provenance for every model you serve
model_registry(version PK, base_model, trained_at, macro_f1_synth,
               macro_f1_gold, thresholds jsonb, notes)
```

**Privacy stance:** `findings` stores only a `text_hash`. Raw strings land in `snippets`
only when the user submits feedback on that specific item. `url_hash` rather than the
full URL keeps query strings — which routinely contain session tokens and emails — out
of the database entirely.

---

## 7. Performance budget

| Stage | Budget |
|---|---|
| DOM extraction, 500 nodes | < 30 ms |
| Client rule pass | < 10 ms |
| Network round trip (local) | < 20 ms |
| Redis batch lookup, 64 keys | < 5 ms |
| ONNX int8 inference, batch 32, seq 64, CPU | 30–60 ms |
| Threshold + merge + serialise | < 5 ms |
| **Total per batch** | **< 100 ms** |

Levers if you miss it: raise the cache hit rate (the same strings recur constantly
across an e-commerce site), drop `max_length` to 48, quantize to int8 if you haven't,
switch to MiniLM, or move inference in-browser via transformers.js.

---

## 8. Repository layout

```
dark-pattern-detector/
├── pyproject.toml              # uv workspace root
├── uv.lock
├── .python-version
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PHASES.md
│   ├── ANNOTATION_GUIDE.md
│   └── model_card.md
├── data/
│   ├── synthetic/              # the 27k trilingual dataset
│   └── gold/                   # hand-annotated real-site snippets
├── ml/
│   ├── notebooks/01_finetune_colab.ipynb
│   ├── train.py                # HF Trainer, multi-label
│   ├── tune_thresholds.py      # per-class thresholds on val
│   ├── evaluate.py             # both splits + gold set
│   ├── export_onnx.py          # export + dynamic int8
│   └── artifacts/model_v1/
├── packages/
│   ├── dp_core/                # taxonomy, label_map, role keywords, scoring
│   └── dp_rules/               # deterministic detectors (Python mirror)
├── apps/
│   └── api/                    # FastAPI service
├── extension/                  # WXT + React + TS + Tailwind + shadcn/ui
│   ├── wxt.config.ts
│   └── src/{entrypoints,lib,ui}/
├── dashboard/                  # optional Next.js aggregate view
├── infra/
│   ├── docker-compose.yml      # api + redis + postgres
│   └── Dockerfile.api
└── tests/
    ├── test_rules.py
    ├── test_api.py
    └── fixtures/pages/         # saved real HTML for regression tests
```

`packages/dp_core` exists so the label order, role keywords and score formula have
exactly one definition. The TypeScript side consumes a generated JSON mirror of it —
never a hand-copied duplicate.

---

## 9. Configuration

| Variable | Default | Notes |
|---|---|---|
| `DP_MODEL_DIR` | `ml/artifacts/model_v1` | ONNX + tokenizer + thresholds |
| `DP_MODEL_VERSION` | from `model_registry` | goes into cache keys |
| `DP_THRESHOLD_PROFILE` | `precision` | `precision`/`balanced`/`recall` |
| `DP_REDIS_URL` | `redis://localhost:6379/0` | cache |
| `DP_DATABASE_URL` | `postgresql+asyncpg://…` | findings |
| `DP_MAX_BATCH` | `64` | request validation ceiling |
| `DP_CACHE_TTL` | `604800` | 7 days |
| `DP_PERSIST_FINDINGS` | `true` | off for privacy-strict demos |

---

## 10. Testing strategy

| Layer | Approach |
|---|---|
| Rules | Unit tests over saved HTML fixtures in `tests/fixtures/pages/` |
| Model | Frozen eval script; metrics committed to `metrics.json` per version |
| API | `httpx.AsyncClient` contract tests, including malformed and oversized batches |
| Extension | Vitest for extractor logic; Playwright against local fixture pages |
| Regression | A pinned set of ~20 real snippets with known labels; CI fails on drift |
| Latency | `pytest-benchmark` gate: batch of 32 must stay under 100 ms |

Save real HTML fixtures early. Live sites change weekly and will invalidate your
screenshots and your demo the night before submission.

---

## 11. Ethics, legal framing, observability

- **Language discipline.** UI copy and report text say *"potentially manipulative
  pattern"*. Never *"illegal"*, *"violation"*, or *"fraud"*. India's CCPA 2023
  guidelines on dark patterns and the EU DSA belong in your motivation and related-work
  sections as context, not as verdicts your tool renders.
- **Attribution risk.** Flagging a named retailer is a claim about that retailer.
  Precision-favoured thresholds and "possible/likely" bands exist for this reason.
- **User control.** Scanning is user-initiated, per-page, and toggleable. No background
  crawling, no telemetry the user hasn't opted into.
- **Observability.** Structured JSON logs with a request id; counters for
  cache hit rate, per-class prediction volume, p50/p95/p99 latency, rule-vs-model
  agreement rate. That last metric is a genuinely interesting result for the write-up.

---

## 12. Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Synthetic→real distribution shift | **High** | Hand-annotated gold set is the only reported headline metric |
| Nepali tokenizer fragmentation | **High** | Fertility measurement in Phase 1; MuRIL fallback |
| Model memorises templates | Medium | Template-disjoint split; 3 epochs; early stopping |
| Cross-origin iframes unreachable | Medium | Document as a known coverage limit |
| Site DOM changes break selectors | Medium | Saved HTML fixtures; text-hash-based reconciliation |
| Latency target missed | Medium | int8, cache, MiniLM, shorter `max_length` |
| Timer mutations flood the API | Medium | 300 ms debounce; local-only timer counting |
| Scope creep into dashboard | Medium | Dashboard is explicitly Phase 8, cuttable |

---

## 13. Decisions log

| # | Decision | Rationale |
|---|---|---|
| 1 | Multilingual base, not English DistilBERT | Devanagari tokenization |
| 2 | Multi-label over multi-class | Real snippets exhibit co-occurring patterns |
| 3 | `benign` as an explicit trainable class | Without it the model flags everything |
| 4 | Hybrid rules + ML | Timers and pre-checked boxes are structural, not textual |
| 5 | Context tokens in the model input | `role=cancel` is decisive for confirmshaming |
| 6 | ONNX int8 for serving | Latency budget on CPU |
| 7 | Template-disjoint split as the reported synthetic metric | Random split overstates by ~15 F1 points |
| 8 | Precision-favoured thresholds | Cost asymmetry of false accusations |
| 9 | Hash-only persistence by default | Privacy, and query strings leak secrets |
| 10 | WXT over raw MV3 tooling | HMR and cross-browser builds out of the box |
