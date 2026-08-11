# Progress log

A running record of what was done, what was decided, and why. Written so the project can
be picked up after any gap without re-reading conversations.

---

## Stage 1 -- Foundation and model

### 1. Dataset, three versions

| Version | Rows | Change | Outcome |
|---|---|---|---|
| v1 | 27,000 | 714 templates, three languages | baseline 0.9586 -- suspiciously high |
| v2 | 28,483 | +1,483 hard negatives | baseline 0.9258 |
| **v2.1** | **28,450** | 549 labels corrected, 33 rows dropped | baseline 0.8987 |

**Why v1's 0.9586 was a problem, not an achievement.** A diagnostic found that **zero**
of 440 benign test rows contained the words stock, left, only or remaining. Every
scarcity cue was a perfect keyword giveaway, so TF-IDF could win without understanding
anything. v2 added benign sentences that use dark-pattern vocabulary honestly ("3 sizes
left in this style"), which is the only way to show a context-reading model earning its
keep.

**Why v2.1 was needed.** Three template families were mislabelled: two social_proof
templates that were really benign static aggregates, one false_urgency template stating
a genuine delivery deadline, and one hard negative colliding with social_proof. The
annotation rule that resolves them is now written down in docs/ANNOTATION.md:

> A statistic is **manipulative** when it induces urgency or peer pressure through
> **unverifiable real-time activity**. It is **benign** when it is a **static, verifiable
> aggregate**. A real stated deadline is benign; a fabricated or resetting one is dark.

v2.1 text and splits are byte-identical to v2 -- only labels changed. Verified: 0 texts
added, 0 removed, no exact or conceptual contradictions remaining.

**Three versions is the limit. Do not build a v2.2.**

### 2. Base model chosen by measurement

Tokenizer fertility was measured before any training. mDistilBERT fragments Nepali
1.95x worse than MuRIL (2.937 vs 1.508 tokens per word) against a 1.5x switching
threshold fixed in advance, so **google/muril-base-cased is the primary model**. It also
won on Hindi and English with zero UNK tokens.

p95 token length was 34, so max_length=64 is comfortable.

The cost is accepted knowingly: MuRIL's 197k vocabulary makes embeddings about 64% of
its 236M parameters, producing a ~950 MB artifact.

### 3. Results

v2.1, template-disjoint test: baseline 0.8987, MuRIL flat-0.5 0.8280, **MuRIL tuned
0.9019**. Threshold tuning contributed +0.0739; the architecture contributed +0.0032.

The transformer ties the baseline on synthetic data and the documentation says so. The
real claims are per-class: false_urgency +0.083 with precision 0.756 to 0.908, English
+0.062, and per-language spread down from 0.074 to 0.0200. Those land exactly where the
hard negatives were added, confirming the hypothesis the dataset was built to test.

Full tables in docs/RESULTS.md.

### 4. Export -- the expensive lesson

Dynamic int8 quantization was attempted in three configurations and **collapsed all
seven dark classes to zero positive predictions** every time (mean abs probability
difference about 0.093, label agreement about 84%), while fp32 reproduced PyTorch
exactly (0.00000, 100.00%). Excluding the embedding table changed the outcome by 0.001.

**Decision: ship fp32, roughly 950 MB. Closed.** The real size fix is vocabulary pruning
in Stage 4, not quantization.

Two export settings are load-bearing and must not be changed:

1. the torch.export (dynamo) exporter -- the legacy exporter (dynamo=False) freezes the
   padding branch at trace length and is silently wrong at other sequence lengths
2. opset_version=18 -- requesting 17 triggers a downgrade that corrupts shape metadata
   and breaks quantization with a (768) vs (8) shape inference error

Nothing raised an exception during any of this. The export succeeded, the model loaded,
and the smoke test printed plausible probabilities. **The parity test is the only reason
this was caught before Stage 2, which retroactively justifies building it.**

### 5. The artifact that was never actually lost

The Colab session hit its GPU limit before the bundle appeared in any handoff zip, and
this was recorded for a while as data loss requiring a 40-minute re-run on a fresh
account. It was not. `model.onnx` (951,654,037 bytes, fp32) had been on local disk at
`ml/artifacts/model_v1/` the whole time. It was missing from the zips because
`git archive` omits gitignored files by design, and the bundle is gitignored for the
obvious reason that it is ~950 MB.

Parity (100.00% / 0.00000) and the smoke check (`scarcity=0.626`) confirm it is the
same bundle every metric in docs/RESULTS.md was measured from. **No re-run was needed
and none was done.**

The lesson worth keeping: "absent from the artifact I was inspecting" is not the same
claim as "does not exist", and the difference cost real time here.

Mitigation applied anyway, since the original failure mode is real: checkpoints now
write to /content/dp_checkpoints instead of Google Drive, so a full Drive can no longer
kill a run mid-training. Only the final bundle touches Drive.

---

## Stage 2 -- Inference service

### 1. What was built

A FastAPI service over onnxruntime with three endpoints: `POST /v1/classify`,
`GET /healthz` and `GET /readyz`. The artifact bundle is the only thing shared with
`ml/`; the backend never imports that package.

`GET /v1/rules` and `POST /v1/feedback` were deliberately **not** stubbed. They are
late Stage 3 and Stage 4 respectively, and a 501 stub is maintenance with no user.

### 2. The invariants stopped being documentation and became code

Each of the first four invariants now has an enforcement point that aborts startup
rather than degrading. `/readyz` returns 503 with the reason; `/v1/classify`
returns 503 while the engine is absent.

| Invariant | Enforced in |
|---|---|
| Label order frozen | `core/taxonomy.verify_label_order`, called from `load_bundle` |
| `build_model_input` identical to `ml/` | `core/model_input.py` + `tests/test_model_input.py` |
| Thresholds only from `thresholds.json` | `core/bundle._load_thresholds` |
| Model version in every cache key | `core/hashing.cache_key`, cross-checked against the manifest |

**Why abort instead of degrade.** A service with a permuted label axis or a stale
model version returns 200s and well-formed JSON while every prediction is wrong,
and nothing raises. That is the same failure shape as the int8 collapse, so it gets
the same answer: fail loudly and early.

The bundle loader also rejects a `model.onnx` under 50 MB, which is the 0.1 MB
dynamo pointer-file trap.

### 3. The Stage 1 smoke value is now a startup gate

The exporter's reference input reproduces `scarcity 0.626`. Startup asserts that
within 0.05 and refuses readiness otherwise. This does not replace `make parity` --
the smoke test cannot detect a destroyed model on its own -- but the reference value
turns "the API started cleanly and called everything benign" into a 503.

### 4. Architecture split so the decision logic is testable without the graph

`model.onnx` is gitignored, so CI will never have it. `services/postprocess.py`
imports only numpy and `core/*` plus `services/cache.py` are stdlib-only.
Everything touching `onnxruntime` or `tokenizers` lives behind
`InferenceEngine.__init__`. The threshold, multi-label and benign rules are
therefore unit-tested on every run.

### 5. Two hashes, not one

`snippet_id` is `sha1(lang + NUL + text)` and ignores tag and role by design, so a
sentence keeps one id wherever it appears. The cache key cannot work that way: tag
and role change the prediction, which is the entire reason `model_input` carries
them. Keying the cache on `snippet_id` would serve a paragraph's prediction for the
same words on a cancel button. A test asserts the two stay distinct.

### 6. Latency is not claimed

The under-100 ms budget was written while int8 was still assumed.
fp32 MuRIL on CPU will exceed it. The handler logs requests over budget rather
than pretending; the number gets measured on real hardware and then the budget gets
corrected. Mitigations already in place: cache hits, in-request dedup of repeated
page copy, and padding to the longest row in a batch rather than to `max_length=64`
(p95 token length is 34). If that is not enough, the fix is Stage 4 vocabulary
pruning. Quantization stays closed.

### 7. What was verified, and what was not

30 checks pass without the model: `build_model_input` byte-identical to
`ml/src/ml/config.py` across seven cases including Devanagari and embedded bracket
syntax; the real bundle's committed evidence files loading and yielding exactly the
tuned threshold vector; fifteen distinct rejection paths; stable sigmoid,
per-class thresholds, multi-label ordering and benign handling; cache TTL, LRU and
thread safety; request validation and tag/role normalisation.

**Since resolved.** The bundle was located on local disk (see section 5), and all of
the above is now verified: the smoke check reproduces `scarcity=0.626` at startup,
inference runs against the real fp32 graph, and latency is measured — see
docs/RESULTS.md section 5, where it turns out to be roughly 16x the original budget.

Rationale in plain language: docs/BACKEND.md.

---

## Stage 3 -- Chrome extension

### 1. What was built

MV3 extension (WXT + React + TypeScript): DOM extraction with a debounced
`MutationObserver`, ten structural rules evaluated in-page, batching and dedupe in the
background service worker, an overlay of badges in a closed shadow root, and a side
panel grouping findings by category with a per-finding detail view.

### 2. Identity had to be split in two

`candidate.id` was originally `sha1(lang + text)`. Three "Add to Cart" buttons on one
listing page therefore collapsed into a single candidate, and only the first one ever
got a badge. Split into `occurrenceId(lang, text, selector)` — unique per DOM node,
used for addressing — and `modelCacheKey(lang, text, tag, role)` — what the dedupe
cache is keyed by, so identical controls still share one forward pass. Conflating
them costs either correctness or the entire benefit of caching.

### 3. The overlay must fail closed, per item

Two failures with the same shape: a resolver that guessed produced badges on the wrong
element after an SPA re-render, and one bad cached item threw inside `render()` after
the badge container had already been cleared, wiping every badge on the page and doing
so again on each subsequent scroll. Both were fixed by refusing rather than guessing —
`resolve.ts` returns `null` on an ambiguous or already-claimed match — and by wrapping
each item's render in its own `try/catch`, so one bad finding costs one badge.

### 4. Badge placement is a scoring problem, not a rule

"Above the target, else below" cannot work on a dense product grid: in a price block
every position collides with something. Placement now scores six candidate positions
against the rectangles of rendered text (`Range.getClientRects()`) and takes the least
obstructive, collapsing the badge to an icon when nothing is clean. Two lessons paid
for here: badges must be **measured** rather than assumed to be a fixed size, and the
search region must be sized by the *badge*, not the target — a 140px badge on a 48px
discount covers text that no probe around the target ever samples.

### 5. Findings belong to a document, not a tab

On an SPA an in-page navigation replaces the DOM but does not reload the content
script, so its accumulated state carried the previous route's findings onto the next
page. Clearing on a navigation event was racy. Findings now carry the document URL
they describe and **every reader validates it for itself**, which is correct whether or
not any cleanup listener ran in time.

---

## Stage 4 -- Evaluation, and two additions beyond the original plan

### 1. LLM explanations (`POST /v1/explain`)

On-demand, one finding at a time, when a user expands it in the side panel. The
fine-tuned classifier remains the source of truth for *what* was detected; the LLM is
a presentation layer over *why it matters* and has no path back into a label, a score
or the page score.

Two defences that are not optional. Page text is **untrusted input** — it is fenced,
and the system prompt names those blocks as data — and the wording discipline is
enforced **in code**, not only in the prompt: a generation containing legal-claim
language is rejected and the UI falls back to the static description. A prompt is a
request, not a guarantee, and the project's entire framing depends on never making
that claim.

### 2. Trace archive (`POST /v1/traces`, MinIO)

Every gap found during Stage 3 was found the same way — a rule that never fires on
real phrasing, a role misinferred on a real layout — and each time, investigating meant
re-finding the page and re-scanning it. The archive turns that into a query.

Objects live in MinIO; a SQLite table indexes host, URL, time, counts and labels,
because object storage can answer "give me this key" and "list this prefix" and
nothing else. Archiving is a **button**, not a setting: a trace is real text from the
page in front of the user, so consent is given per capture rather than once and then
forgotten.

### 3. Latency, finally measured

`make bench`. A batch of 32 takes ~620 ms p50, against a 40 ms budget written under
the int8 assumption that section 4 of docs/RESULTS.md documents abandoning. This is
arithmetic, not a bug, and it explains why a 600-candidate page takes tens of seconds
to resolve fully. Full analysis and the options that would actually move it:
docs/RESULTS.md section 5.

### 4. Gold set: tooling built, annotation outstanding

`make gold-candidates` samples an annotation sheet from archived traces — stratified
by predicted label and language, half drawn from candidates the model called benign so
that false negatives are findable at all. `make gold-eval` scores annotations per
class and per language, and reports the rule ablation.

**The annotation itself is not done.** It is human work by design: labels produced by
the model under evaluation would make the evaluation circular. Until it exists, every
number in this project is measured on synthetic data it generated itself.

---

## Decisions that will not be revisited

| Decision | Reason |
|---|---|
| MuRIL over mDistilBERT | 1.95x Nepali fertility gap, measured before training |
| fp32 over int8 | int8 collapsed all seven dark classes, three times |
| precision threshold profile | the recall profile drives social_proof precision to 0.155; false positives destroy extension trust |
| template-disjoint split as headline | the random split leaks templates and inflates results by +0.0917 |
| multi-label, not multi-class | one snippet can be both scarcity and false_urgency |
| three dataset versions maximum | further churn adds effort, not evidence |

---

## Five invariants

1. Label order frozen: confirmshaming, false_urgency, forced_action, obstruction,
   scarcity, sneaking, social_proof, benign.
2. build_model_input byte-identical across ml/ and backend/.
3. Thresholds always loaded from thresholds.json, never hardcoded.
4. Model version in every cache key.
5. split_random never reported as a headline number.

---

## Extraction fields, and two defects they fixed (2026-08-11)

Reported symptoms: the same text badged twice, an entire product image outlined as
a finding, and product titles labelled as dark patterns. All three were reproduced
in unit fixtures against the real extraction and rule code before anything was
changed.

**Wrapper/child double extraction.** The leaf-block fallback and ordinary
direct-text extraction both fire on `<div class="sold"><span>958 sold</span></div>`:
the div has no direct text, so the child is coalesced and emitted, then the child
emits it again. Both survive `seen`, which is keyed by `occurrenceId` and folds in
the selector. Measured on a Daraz-shaped card: 13 candidates for 8 distinct
strings, five doubled. `collapseNestedDuplicates` now keeps the innermost element
and inherits the wrapper's role -- the role carries the site's own class-name
signal (`stock-info`, `pdp-discount`) and is part of the model input, so dropping
it would have changed the question the model is asked.

That also fixed the image case: `<img>` is an inline tag, so `<a><img><span>title
</span></a>` is a leaf block whose text is the title but whose element spans the
image. The badge was faithfully outlining the element it was handed.

**A rule with no idea what it was reading.** `stock_counter` matches
`/limited\s+(time|offer|stock)/i` unanchored, so "Hot Sale Wireless Earbuds
Limited Stock Offer" was reported as `scarcity` -- at `likely`, the strongest
confidence in the UI, since a rule-only hit outranks a model-only one. Measured
against the live backend, the classifier called the same title **benign at 0.896**:
the rule layer was the source of the false positive, not the model.

This is the same class of defect as the `"N sold"` finding in RESULTS.md sections
6-7, and it was equally invisible offline: the 400-row silver set contains **zero**
rows matching `limited (time|offer|stock)`, `lowest price` or `hurry`, and it is
deduplicated by text (393 distinct texts in 400 rows), so neither the false
positive nor the duplication could show up in `make gold-eval`.

**The fix was not more rules.** Rule count governs recall; every reported symptom
was a false positive. What the rules lacked was knowledge of *what they were
reading*. `lib/extract/fields.ts` now infers a field -- title, price, strike_price,
discount, rating, sold_count, stock, shipping, unknown -- from structural evidence
(`<s>`/`<del>`, `<a href>`, heading tags, repeated sibling templates) and text
shape, never from site-specific selectors. Text-matching rules declare the fields
they must not fire on. `unknown` never blocks anything: absence of evidence is not
evidence.

Verified on Daraz-shaped and Amazon-shaped fixtures: titles containing "Limited
Stock" and "Limited time deal" produce no rule hits, while a standalone "Limited
time deal" *badge* still fires `stock_counter` -- the discrimination the rule
always needed and never had.

**Not measured on live pages.** Field inference is verified only on unit fixtures.
`strike_price` depends on computed `text-decoration`, which jsdom does not
evaluate, so its live behaviour is unverified. A trace from a real storefront is
the next thing needed.

---

## Source-verified architecture audit, and the four changes it produced (2026-08-11)

`PROJECT_ARCHITECTURE_AND_DATAFLOW.md` was written as a read-only pass over the
executable source, tagging every claim VERIFIED / INFERRED / DOCUMENTED-BUT-NOT-
VERIFIED / UNKNOWN. It found eight documentation-versus-code mismatches. Four
changes followed.

**A privacy gap existed and nobody had written it down.** There was no exclusion of
any kind: every visible string meeting the length and visibility filters was POSTed
to `/v1/classify`, on a checkout or account page as much as a product page. A tenth
field value, `personal`, now catches email addresses, payment-card-shaped digit runs
and long order/account/phone numbers, checked *before every other field* so an
identifier can never be typed as a price and travel on that basis. Those candidates
are never sent and no rule may report on them.

Exclusion rather than redaction, because a partially-scrubbed identifier is worse
than none. No page-type gate, because checkout is exactly where `late_fee`,
`forced_action` and pre-checked opt-ins live -- gating on `step` would blind the tool
where its best evidence is. It does **not** detect names or street addresses; a test
asserts that a real captured address is not typed `personal`, so the limitation
cannot be quietly forgotten.

**Invariant #4 stopped at the wire.** The backend folds model version and threshold
profile into its own `cache_key`; the extension's cache was keyed by
lang+tag+role+text alone. Restarting the backend on a different profile left every
open tab serving the previous model's answers for the rest of the browser session.
The cache is now an envelope stamped with `${model_version}:${threshold_profile}`
from response `meta`, discarded when that changes; a cache from an older build is
dropped rather than adopted.

That module started inline in `background.ts` with its logic restated in a test --
which the test's own comment admitted could drift. The production build then
rejected the test file outright, because WXT treats every file under `entrypoints/`
as an entrypoint and it collided with `background`. Extracting it to
`lib/classify-cache.ts` fixed both problems at once. **The build caught a design
weakness the tests could not.**

**`countdown_timer` tests `is_animated` and nothing else.** There is no clock-shape
check anywhere in it, so a rotating price or a live rating would be reported as a
deadline. Requiring `MM:SS` was the obvious fix and is wrong -- a real countdown
rendered "Ends in 1 day 06:44:40" appears verbatim in a captured trace and would
fail it. Field-gating instead: refused on `price`, `strike_price`, `rating`,
`sold_count`, `title`. A ticking number in an `unknown` field is still
`false_urgency`, and `unknown` is the majority field on every real page measured.

**One audit finding was wrong, and the reason is worth keeping.** M5 claimed
`hash.ts` used a space separator where the backend uses NUL. It never did. The file
stored a **literal NUL byte** instead of the escape `"\u0000"`, and a raw NUL is
invisible to every tool used to read source: `grep` treats the file as binary and
silently reports nothing, `git diff` refuses to show it, and every viewer renders it
as a space. The byte is now written as an escape -- behaviourally identical, and no
longer able to mislead. The audit document's own first draft had the same defect,
having embedded two raw NULs while quoting that very separator.

The lesson generalises past this file: **a tool reporting nothing is not the same as
a tool reporting no matches**, and this is the second time in this project that a
confident reading of invisible state was wrong.

---

## Known open items

| Item | Priority | Stage |
|---|---|---|
| ~~`stock_counter` contradicted docs/ANNOTATION.md on `"N sold"`~~ -- **fixed**. Rule no longer matches bare sale counts; new `recent_activity` rule covers the recency-bounded phrasing that is genuinely dark. Rule-layer contribution moved from -0.134 to +0.323 macro-F1 | -- | done |
| `"Gems save Rs. N"` classified `sneaking` -- 46 real-site false positives, model-only. Genuinely arguable; needs a human annotator to settle | medium | 4 |
| Real-site labels are LLM-produced (silver set). A human-labelled subset, even 100 rows, would materially strengthen every real-site claim | high | 4 |
| Nepali unevaluated on real pages -- only 3 of 400 sampled rows were Devanagari, none dark. The multilingual claim rests on synthetic data alone | high | 4 |
| Inference is ~16x the latency budget (620 ms per batch of 32). A smaller base model is the only change likely to move it an order of magnitude | high | 4 |
| Validation split has 0% multi-label rows while test has 3.2%, distorting tuned thresholds | high | 4 |
| ~~`"958 sold"` suspected false positive~~ -- **confirmed**, 39 occurrences in 400 rows. See the contradiction row above | -- | done |
| MuRIL vocabulary pruning, 197k to about 30k, target roughly 200 MB | medium | 4 |
| Findings carry `source` but not the *names* of the rules that fired, so `/v1/explain` prompts say "a rule matched" rather than which one | low | any |
| `GET /v1/rules` deferred by design; trigger (rule updates without rebuilding the extension) has not fired | low | deferred |
| transformers 5.x could not resolve eval_macro_f1_dark, so early stopping was silently disabled | low | note in report |
| Remove the colliding hard-negative template, index 00, all three languages | low | any |
| Append a v2.1 section to docs/DATASET_V2.md | low | any |

---

## Process rules learned the hard way

- **Do not patch code on a hypothesis.** Two export patches were made on plausible
  reasoning before measuring, and both hypotheses were wrong. Measure, then patch.
- **Verify which dataset produced any given metric** using support counts and the
  manifest dataset field. Stale cached modules once produced results labelled as v2.1
  that were actually v2.
- **A perfect parity score can be a bug signal.** 0.00000 first appeared from a 0.1 MB
  pointer file silently loading a sidecar next to it.
- **Restart the Colab runtime after pulling code**, or module caching serves the old
  version while the correct file sits on disk. But never restart mid-run, because
  trained weights in /content are lost with the session.
- **Never treat the smoke test as verification.** It prints plausible numbers for a
  destroyed model.
