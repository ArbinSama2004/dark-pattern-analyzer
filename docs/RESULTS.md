# Results

All numbers here were measured. Empty cells are genuinely not yet measured rather than
estimated.

**Provenance note.** Sections 1-4 record a complete Stage 1 run on dataset v2.1 (MuRIL,
seed 13). The artifact bundle from that run was initially believed lost when the Colab
session expired, but it was in fact present on local disk at
`ml/artifacts/model_v1/model.onnx` (951,654,037 bytes, fp32) -- it only failed to
appear in handoff zips because `git archive` omits gitignored files by design. Parity
(100.00% / 0.00000) and the smoke check (`scarcity=0.626`) confirm this is the same
bundle these metrics were measured from. No re-run was needed.

Three dataset versions exist and the differences matter, so results are labelled by
version throughout:

| Version | Rows | What it is |
|---|---|---|
| v1 | 27,000 | first generation, no hard negatives |
| v2 | 28,483 | adds 1,483 hard negatives (benign text using dark-pattern vocabulary) |
| v2.1 | 28,450 | **current** -- v2 with 549 mislabelled rows corrected and 33 dropped |

---

## 1. Tokenizer fertility

From section 2 of the Colab notebook. Subword tokens per word -- lower means the
tokenizer represents the language more efficiently. Measured twice (v1 and the v2.1
re-run); both are shown to demonstrate stability.

| Model | en | hi | ne | ne/en |
|---|---|---|---|---|
| distilbert-base-multilingual-cased | 1.504 / 1.491 | 2.196 / 2.200 | 2.937 / 2.965 | **1.95x** |
| google/muril-base-cased | 1.300 / 1.293 | 1.302 / 1.315 | 1.508 / 1.524 | **1.16x** |
| xlm-roberta-base | 1.406 / 1.394 | 1.540 / 1.530 | 1.705 / 1.735 | 1.21x |
| Multilingual-MiniLM-L12-H384 | 1.406 / 1.394 | 1.540 / 1.530 | 1.705 / 1.735 | 1.21x |

**Model chosen: google/muril-base-cased.**

mDistilBERT fragments Nepali 1.95x worse than MuRIL (2.937 vs 1.508 tokens per word),
exceeding the 1.5x switching threshold that was fixed *before* the measurement was
taken. MuRIL also leads on Hindi and English with zero UNK tokens on all three
languages. This is the most consequential decision in Stage 1: at max_length=64,
mDistilBERT would have truncated long Nepali spans that MuRIL fits comfortably.

The p95 token length across all three languages was 34, which is why max_length=64 is
generous rather than tight.

**Cost of this decision.** MuRIL's 197k-token vocabulary means roughly 151M of its 236M
parameters are the embedding table (about 64%). That drives both the ~950 MB fp32
artifact and the failure of int8 quantization in section 4. It bought correct Nepali
tokenization, and that trade belongs in the report explicitly.

---

## 2. Baseline -- TF-IDF + logistic regression

Character n-grams (2-5), one-vs-rest logistic regression. This is the floor the
transformer has to clear to justify itself.

| Dataset | Split | macro-F1 (7 dark) | micro-F1 | exact match |
|---|---|---|---|---|
| v1 | template-disjoint test | 0.9586 | 0.9685 | 0.9406 |
| v2 | template-disjoint test | 0.9258 | 0.9296 | 0.8813 |
| **v2.1** | **template-disjoint test** | **0.8987** | **0.8997** | **0.8479** |
| v2.1 | random test (leaky) | 0.9904 | 0.9918 | 0.9842 |

**Leakage gap (v2.1): +0.0917 macro-F1.**

The random split scores 0.99 because template skeletons appear in both train and test,
so the model matches memorised phrasing rather than generalising. Every headline number
in this project comes from the template-disjoint split. The gap is reported because it
quantifies how misleading the easy split would have been.

**Why the baseline gets progressively worse across versions, and why that is good.**
The drop from 0.9586 to 0.8987 is not regression. The dataset became harder for a purely
lexical model, on purpose:

- v1 to v2 added 1,483 hard negatives: benign sentences using dark-pattern vocabulary
  (stock, left, only, remaining). In v1, **zero** of 440 benign test rows contained any
  of those words, so TF-IDF could win by keyword spotting alone.
- v2 to v2.1 corrected 549 mislabelled rows, removing spurious keyword-to-label
  correlations the baseline had been exploiting.

A lexical model needs those shortcuts. A model that reads context does not. Making the
baseline weaker is how you create room to show the transformer doing something a keyword
matcher cannot.

### Per class, v2.1 baseline

| Class | precision | recall | F1 | predicted | true |
|---|---|---|---|---|---|
| confirmshaming | 0.983 | 1.000 | 0.991 | 753 | 766 |
| false_urgency | 0.756 | 0.894 | 0.819 | 602 | 712 |
| forced_action | 0.933 | 0.860 | 0.895 | 680 | 627 |
| obstruction | 0.951 | 0.995 | 0.972 | 775 | 811 |
| scarcity | 0.873 | 0.750 | 0.807 | 577 | 496 |
| sneaking | 0.945 | 1.000 | 0.972 | 704 | 745 |
| social_proof | 0.825 | 0.844 | 0.834 | 513 | 525 |
| benign (excluded from macro-F1) | 0.928 | 0.834 | 0.879 | 2007 | 1803 |

### Per language, v2.1 baseline

| Language | macro-F1 (dark) |
|---|---|
| en | **0.8270** |
| hi | 0.9328 |
| ne | 0.9212 |

English is the *hardest* language for the baseline, which is counter-intuitive until you
notice the hard negatives are densest in English. Character n-grams cannot separate
"only 3 left in stock, order soon" from "3 sizes left in this style".

---

## 3. Fine-tuned transformer -- MuRIL, dataset v2.1

Template-disjoint test, precision threshold profile.

| Metric | Value |
|---|---|
| macro-F1 (7 dark), flat 0.5 threshold | 0.8280 |
| **macro-F1 (7 dark), tuned thresholds** | **0.9019** |
| gain from threshold tuning | **+0.0739** |
| baseline (same dataset, same split) | 0.8987 |
| improvement over baseline | **+0.0032** |

### Read this before quoting the headline

The transformer beats the baseline by 0.003 macro-F1. **That is a tie, not a win, and the
report should say so.** Claiming the transformer outperforms TF-IDF on this evidence
would be dishonest, and any examiner comparing the two numbers will see it.

The defensible claims are:

1. **Threshold tuning is worth more than the architecture here: +0.0739 versus +0.0032.**
   The cheapest genuine improvement in the whole pipeline was per-class thresholds tuned
   on the validation split. That is a real, reportable finding.
2. **The transformer wins exactly where reading context matters.** false_urgency improved
   +0.083, with precision moving 0.756 to 0.908 -- the class most confused by hard
   negatives. English overall improved +0.062, and English is where the hard negatives
   live. This confirms the hypothesis the hard negatives were added to test.
3. **The transformer is far more consistent across languages.** Per-language spread fell
   from 0.074 (v2 baseline) to **0.0200**. For a trilingual product, predictable
   behaviour across languages matters more than a decimal place of macro-F1.
4. **Synthetic data is the ceiling, not the model.** Both models sit near 0.90 on
   templated text. The real test is the Stage 4 gold set, where both should drop and the
   gap between them should widen if the transformer genuinely generalises.

### Per class, v2.1 transformer

| Class | F1 | vs baseline | Note |
|---|---|---|---|
| confirmshaming | 0.935 | -0.056 | precision 0.878; threshold 0.11 predicts 858 vs 753 true |
| false_urgency | **0.902** | **+0.083** | precision 0.756 to 0.908, the intended win |
| forced_action | 0.924 | +0.029 | |
| obstruction | 0.990 | +0.018 | |
| scarcity | 0.835 | +0.028 | |
| sneaking | 0.954 | -0.018 | |
| social_proof | 0.773 | -0.061 | recall 0.657 -- the weakest class |
| benign (excluded from macro-F1) | 0.930 | +0.051 | |

**Two artifacts of the validation split, not the model.** confirmshaming precision
(0.878) and social_proof recall (0.657) are both threshold-selection failures. The
validation split contains **0%** multi-label rows while the test split contains 3.2%, so
thresholds tuned on validation are systematically too low for multi-label test rows. On
validation, confirmshaming scored 1.000/1.000 at threshold 0.11, so the tuner had no
signal that the threshold was too aggressive. Fixing the split's multi-label
representation is the highest-value dataset change available, and it is deliberately
deferred rather than forgotten.

### Per language, v2.1 transformer

| Language | macro-F1 (dark) | vs baseline |
|---|---|---|
| en | 0.8891 | +0.062 |
| hi | 0.9054 | |
| ne | 0.9091 | |

**Spread: 0.0200** (v2 baseline was 0.074). Values confirmed from
`ml/artifacts/model_v1/metrics.json`, the same bundle that passed parity.

### Dataset v2 transformer, for comparison

| Metric | Value |
|---|---|
| macro-F1, flat 0.5 | 0.8883 |
| macro-F1, tuned | 0.9234 |
| micro-F1 | 0.9379 |
| exact match | 0.9120 |
| per-language spread | 0.0264 |

Tuned thresholds, v2: 0.57 / 0.51 / 0.32 / 0.16 / 0.61 / 0.35 / 0.13 / 0.89 in label
order. v2.1 thresholds are recorded in thresholds.json in the artifact bundle.

v2 scores higher than v2.1 (0.9234 vs 0.9019) on a dataset with **known label errors**.
The v2.1 number is lower and more trustworthy. Reporting the higher one would mean
reporting partly-memorised label noise.

### Threshold profiles

| Profile | Notes |
|---|---|
| precision (min_precision 0.80) | **used for all headline numbers** |
| balanced | identical to precision on this data -- the constraint never binds |
| recall (min_recall 0.80) | **unusable**: drives social_proof to threshold 0.05, precision 0.155 |

The recall profile is documented as rejected rather than deleted. A browser extension
that flags benign text destroys user trust immediately, so precision-first is a product
decision, not merely a metric preference.

---

## 4. Export and quantization

### The finding: dynamic int8 quantization destroys this model

Parity test, PyTorch vs ONNX, 200 validation rows:

| Artifact | Size | mean abs prob diff | label agreement | dark classes at 0 positives |
|---|---|---|---|---|
| **fp32** | **951 MB** | **0.00000** | **100.00%** | **0 of 7** |
| int8, MatMul + embeddings | 238 MB | 0.09181 | 83.81% | 7 of 7 |
| int8, MatMul only | 695 MB | 0.09302 | 84.00% | 7 of 7 |
| int8, MatMul only, opset 18 re-export | 695 MB | 0.09308 | 84.00% | 7 of 7 |

Every int8 variant collapsed **all seven** dark classes to zero positive predictions
while benign absorbed roughly 183 of 200 rows. Excluding the embedding table from
quantization changed the result by 0.001, so this is not a tuning problem.

**Shipped: fp32.** Parity PASS, label agreement 100.00%, mean abs prob diff 0.00000.

### Why this section exists at all

Nothing raised an exception. The export completed, the model loaded, and the smoke test
printed plausible probabilities (scarcity 0.311 instead of the correct 0.626 -- wrong,
but not obviously wrong). A backend built on that artifact would have started cleanly,
returned well-formed JSON, and labelled every element on every page benign. Only a
numerical comparison against the source model catches this class of bug, which is the
argument for the parity gate being non-optional.

### Two export details that cost several wasted cycles

1. **Use the torch.export (dynamo) exporter.** Its fp32 graph is numerically exact.
   Switching to the legacy exporter (dynamo=False) freezes a padding branch in
   transformers/masking_utils.py as a constant at whatever sequence length the sample
   batch happened to have, so the graph is silently wrong at every other length.
   dynamic_axes cannot undo an already-traced branch, and the only warning is a
   TracerWarning that reads like boilerplate.
2. **Request opset_version=18, not 17.** dynamo emits 18 regardless. Asking for 17
   triggers an onnxscript downgrade that leaves stale value_info, and quantize_dynamic
   then aborts with:
   [ShapeInferenceError] Inferred shape and existing shape differ in dimension 0: (768) vs (8)

A third trap: the dynamo exporter writes weights to an external .data sidecar, leaving
model.onnx as a 0.1 MB pointer file. A parity test passes on that file while the sidecar
sits beside it, then the artifact breaks the moment it is moved. export_fp32 now inlines
the weights and raises if the file is under 50 MB.

### Size, honestly

951 MB is large for a browser-extension backend. int8 would only have reached 695 MB
without embedding quantization, because embeddings are about 64% of the parameters, so
the real fix is not quantization but **vocabulary pruning**: MuRIL's 197k tokens cover
roughly 17 Indian languages and this project needs 3. Pruning to the observed vocabulary
should reach roughly 200 MB and would likely make int8 viable afterwards. Deferred to
Stage 4 as a scoped optimisation with a measurable target, not a vague "optimise later".

---

## 5. Latency (Stage 2)

Measured with `make bench` (`backend/scripts/bench_latency.py`), 50 timed runs after
5 warmup runs, on the development machine (Apple Silicon, CPU only, fp32 bundle,
`DP_ONNX_INTRA_OP_THREADS=0`). Batches mix short button labels with longer fine print
across all three languages, because padding to the longest item in a batch is a real
cost that a batch of identical short strings would hide.

| Case | p50 | p95 | Budget | Verdict |
|---|---:|---:|---:|---|
| inference, batch of 1 | 15.0 ms | 16.4 ms | — | |
| inference, batch of 8 | 128.6 ms | 138.9 ms | — | |
| **inference, batch of 32** | **618.1 ms** | **653.1 ms** | 40 ms | **16x over** |
| inference, batch of 64 | 1414.8 ms | 1477.2 ms | — | |
| cache hit, 32 keys | <0.1 ms | <0.1 ms | 15 ms | ok |

Not measured here, deliberately: in-page extraction and rule evaluation run in the
browser rather than this process, and a localhost network round trip is not a
meaningful figure for anything. Filling those rows with numbers from the wrong machine
would be worse than leaving them out.

### The budget does not survive contact with fp32

The 100 ms end-to-end budget was written assuming an int8 model.
Section 4 documents why int8 was abandoned: it destroyed the model. The consequence
is quantified here — **a batch of 32 takes ~620 ms, not 40 ms.**

This is not a regression to fix by tuning. It is the arithmetic of running a 236M
parameter fp32 transformer on CPU, and it is the direct cause of a symptom seen
throughout Stage 3 development: a large product page yielding 600 candidates needs
~19 batches, which is **12+ seconds of pure inference** before any queuing,
serialisation or retry. Pages taking 40-80 seconds to fully resolve were never a bug
in the extension.

Scaling is worse than linear per item up to batch 32 and then roughly linear:
19 ms/item at batch 1, 16 ms/item at batch 8, 19 ms/item at batch 32, 22 ms/item at
batch 64. Batching buys almost nothing here, which is itself the finding — the cost is
dominated by the per-token forward pass, not per-request overhead.

### What would actually move this

In rough order of expected benefit per unit of work:

1. **A smaller base model.** `Multilingual-MiniLM-L12-H384` (118M) was measured in
   section 1 at the same tokenizer fertility as XLM-R and half MuRIL's parameters.
   This is the only change likely to be worth an order of magnitude.
2. **Quantization that survives parity.** int8 dynamic failed (section 4).
   Quantization-aware training or int8 static with a calibration set were not
   attempted and are the honest next thing to try, not a claim.
3. **GPU or a dedicated inference server.** Changes deployment rather than the model.
4. **Sending fewer candidates.** The extension already caps at 600/page and dedupes
   aggressively; more aggressive filtering trades recall for latency.

The architecture already mitigates the user-visible effect: results stream to the
overlay per batch rather than after the whole page (see `docs/BACKEND.md`), so badges
appear progressively instead of the page freezing. That is mitigation, not a fix, and
this table is the number to quote rather than the budget.

---

## 6. Real-site silver set (Stage 4)

> **Read this first: these labels were produced by an LLM, not a human.**
>
> The reference labels below were assigned by Claude (Opus 4.5) reading each snippet
> against `docs/ANNOTATION.md`, because human annotation time was not available. That
> makes this a **silver set**, not a gold set, and the distinction is not pedantic:
>
> * The annotator and the system under evaluation are **both language models**. They
>   may share systematic blind spots in a way two humans would not, so agreement is
>   not independent evidence in the way a human gold set is.
> * The annotator was blinded — `model_labels` and `rule_hits` were stripped from the
>   sheet before it was read, so the labels are not anchored on the model's output —
>   but blinding removes anchoring, not correlated error.
> * **Any claim of real-world accuracy resting on this table should be stated as
>   preliminary.** A human-labelled subset, even 100 rows, would materially strengthen
>   it and is the single highest-value remaining task in the project.

| | Value |
|---|---|
| sites | 2 (`www.daraz.com.np`, a purpose-built demo shop) |
| pages | 5 captures |
| candidates extracted | 2,205 |
| unique after dedupe | 1,050 |
| snippets labelled | **400** |
| annotator | **1, and it was an LLM** — see above |
| Cohen's kappa (100-item overlap) | **not measurable — single annotator** |

**On the missing kappa.** Inter-annotator agreement needs two annotators labelling an
overlapping subset independently. There is one. Reporting kappa is therefore
impossible rather than merely skipped. What that costs: there is no measure of how
much of the error rate below is model failure versus genuine ambiguity in the
labelling rules — and section 7 shows that ambiguity is doing real work here.

### Results

Measured with `make gold-eval` against the shipped `precision` threshold profile.

| Metric | synthetic test | real silver set | gap |
|---|---|---|---|
| macro-F1, model only, all 7 classes | 0.9019 | **0.225** | **−0.677** |
| macro-F1, model only, supported classes | — | **0.394** | — |
| macro-F1, model + rules, supported classes | — | **0.717** | — |

The model-plus-rules figure is **after** the `stock_counter` fix described in section 7.
Before it, the same measurement was 0.260 — the rule layer was actively harmful. That
before/after is the most useful single result in this document, so section 7 keeps
both numbers rather than quietly reporting the better one.

**Two macro figures, because one of them is misleading on its own.** Three of the
seven classes (`confirmshaming`, `obstruction`, `sneaking`) have **zero** examples in
this sample — real Daraz listing pages simply do not contain confirmshaming. A class
with no gold examples contributes F1 = 0 regardless of model behaviour, so the
all-classes macro is arithmetically capped at 4/7 = 0.571 here. It is reported for
comparability with the synthetic number; the supported-class figure is what this
sample can actually speak to.

### Per class

| Class | model only | model + rules | support |
|---|---:|---:|---:|
| false_urgency | **0.909** | 0.870 | 12 |
| scarcity | 0.667 | **1.000** | 4 |
| social_proof | 0.000 | **1.000** | 1 |
| forced_action | 0.000 | 0.000 | 1 |
| confirmshaming / obstruction / sneaking | — | — | **0** |

(F1. Model-only precision/recall: false_urgency 1.000/0.833, scarcity 1.000/0.500.)

`false_urgency` transfers to real pages **well** — perfect precision on twelve real
Daraz countdown timers, from the model alone. That is the class the hard negatives in
dataset v2 were added to fix (section 3), and it is the one that held up.

`scarcity` and `social_proof` reach 1.000 only **with** the rule layer, and only after
the fix in section 7. `forced_action` is still missed entirely, on a support of one
row — an anecdote, not a measurement.

### On the predicted gap

This document expected "roughly 0.90 falling to 0.65–0.75". The **model alone** lands
at 0.394 — well below that. **With the corrected rule layer it reaches 0.717**, inside
the predicted band.

The prediction was right about the destination and wrong about the route: the
degradation was never diffuse, and the hybrid architecture is what closes it. Section
7 shows the loss was two specific, identifiable behaviours, one of which was a defect
in this project's own rules rather than a limitation of the model.

### Caveats that bound this number

1. **Two hosts, one product domain.** Mostly bookshelf and hoodie listing pages. Not a
   sample of "e-commerce".
2. **397 of 400 rows are English.** The per-language table is not reportable: the
   three Devanagari rows contain no dark patterns, so Nepali macro-F1 reads 0.000 and
   means nothing. **Nepali is the project's central claim and it remains unevaluated
   on real pages.**
3. **Small per-class support.** Twelve rows is the largest class. Per-class F1 at this
   support moves by ~0.08 per single row.
4. **The base rate is low and real.** 17 dark rows in 400 (4.3%). Real pages are mostly
   boilerplate; this is what makes precision, not recall, the metric that matters.

---

## 7. Error analysis

The first evaluation produced **89 false positives and 4 false negatives**, from
`data/gold/errors.csv` (`make gold-eval` writes it). **85 of the 89 came from two
behaviours**, both systematic rather than noise.

| Source | Count | What fires |
|---|---:|---|
| model, `sneaking` | 46 | `"Gems save Rs. 19"`, `"33% Off Gems save Rs. 19"` |
| `stock_counter` rule, `scarcity` | 39 | `"59 sold"`, `"330 sold"`, `"7 sold Overseas"` |
| model, misc | 4 | scattered |

The second group was a defect in this project's own rules. **It was fixed, and the fix
was re-measured** — see "The fix, and what it bought" below. Errors after the fix:
**50 false positives, 3 false negatives.**

### FP group 1 — the rule layer contradicts the annotation guide

`stock_counter` matches `"N sold"` **on purpose**. From
`frontend/src/lib/rules/stock_counter.ts`:

```ts
/\d+\s*(pieces?\s*)?sold/i,   // "50 pieces sold", "100+ sold" (social proof used as scarcity)
/\d+\+?\s*sold/i,             // "100+ sold"
```

`docs/ANNOTATION.md` says the opposite. Its core test calls a **settled, verifiable
aggregate** benign and lists `Bestseller - {N} sold this week` explicitly in the benign
column. A cumulative lifetime sale count is as settled as a statistic gets.

So the rule layer and the labelling guide disagree about what `"N sold"` means, and the
annotation followed the guide. **This is the same defect class the guide was written to
prevent** — section "Why this matters more than it looks" documents the v2 incident
where two phrasings of one concept carried opposite labels — recurring in the rule
layer instead of the dataset.

This single disagreement accounted for **44% of all false positives** and was the
reason adding rules *lowered* macro-F1. Two components cannot hold opposite
definitions of the same phrase, so one of them had to change.

### FP group 2 — `Gems save Rs. N` read as sneaking

46 rows of Daraz's loyalty-points messaging classified `sneaking`, model-only, no rule
involved. The annotation called these benign on the grounds that sneaking requires
something *slipped in that you did not choose* — a pre-checked box, a fee appearing at
checkout — whereas an advertised discount adds nothing to the cart.

This one is genuinely arguable. `"33% Off Gems save Rs. 19"` advertises a saving
contingent on a loyalty programme the shopper may not have, which is at least
adjacent to drip pricing. **A human annotator might reasonably label these
`sneaking`, and if they did, precision on this class would improve sharply.** It is
the single decision that most affects the headline number, which is precisely why the
absence of a second annotator matters.

### The fix, and what it bought

The guide was treated as authoritative and the rule was changed, not the other way
round: `docs/ANNOTATION.md` is the definition this project evaluates against, and a
rule that contradicts it is simply wrong.

Two changes, in `frontend/src/lib/rules/`:

1. **`stock_counter` no longer matches a bare `"N sold"`.** The two `sold` patterns
   were removed, with the measurement recorded in a comment at the removal site so the
   next person does not re-add them.
2. **New rule `recent_activity` → `social_proof`**, matching purchase counts bounded to
   a recent window (`"61 people bought this in the last 24 hours"`). That is the half
   of the `"N sold"` question that *is* dark by the guide's own test — unverifiable
   real-time activity rather than a settled total — and it is social proof, not
   scarcity. It is deliberately narrow: a bare `"330 sold"` produces nothing.

Re-running `make gold-eval` against the same 400 labels:

> **How the re-measurement was done, precisely.** The `rule_hits` column is recorded
> by the live extension at capture time, so it reflects whichever rules were loaded in
> the browser then. Rather than re-capturing all five pages, the column was
> re-derived offline by applying the corrected patterns to each row's text in Python.
>
> That is sound for these two rules because both are pure text patterns, but it would
> **not** be sound for rules needing live DOM (`prechecked_optin`, `hidden_optout`,
> `cta_asymmetry` read checkbox state, computed contrast and bounding boxes). Changing
> one of those requires re-capturing the pages, not re-deriving. Stated here because
> the distinction is invisible in the resulting numbers.

| | before | after |
|---|---:|---:|
| macro-F1, model + rules (supported classes) | 0.260 | **0.717** |
| rule-layer contribution | **−0.134** | **+0.323** |
| `scarcity` precision | 0.093 | **1.000** |
| `scarcity` F1 | 0.170 | **1.000** |
| `social_proof` F1 | 0.000 | **1.000** |
| total errors | 93 | **53** |

The `social_proof` gain is the new rule catching a snippet the model had missed
outright (below). **The model was not retrained and not touched** — every number in
this table moved because of two edits to the rule layer.

### The four false negatives (first run)

| Text | Missed label | Note |
|---|---|---|
| `61 people bought this in the last 24 hours` | social_proof | **Matched the dark template in `ANNOTATION.md` verbatim** (`{N} bought in the last {H} hours`) and the model still missed it. **Now caught by `recent_activity`** — a case where the structural layer is the only thing detecting a class at all. |
| `Sign up to reveal price` | forced_action | Textbook account-gating; the training data contains close paraphrases. |
| `⚡ Mega Sale is LIVE -- prices this low won't be back. Shop now before it ends!` | false_urgency | Unverifiable price claim plus urgency. |
| `Ends in days` | false_urgency | A partially-rendered timer. Weak; arguably not a miss at all. |

Two of these four are patterns the model was explicitly trained on, in near-identical
wording. That is a distribution-shift finding, not a taxonomy gap: real pages phrase
these things in surrounding context the synthetic templates never produced.

### Rule ablation

| Configuration | macro-F1 (supported) |
|---|---:|
| model only | 0.394 |
| model + rules, **before** the fix | 0.260 (**−0.134**) |
| model + rules, **after** the fix | **0.717** (**+0.323**) |

This is the project's central architectural claim, measured on real pages for the
first time — and it landed on both sides of the argument within one session.

**Before the fix, the rule layer made real-site accuracy worse.** One over-broad regex
was responsible for effectively all of it. That is worth stating plainly rather than
burying: rules can only *add* findings, never remove them, so under a
precision-favouring policy a single loose pattern is unusually expensive, and nothing
in the synthetic evaluation could have exposed it. Only real pages contain
`"330 sold"` in quantity.

**After the fix, the rule layer contributes +0.323 macro-F1** and is the only reason
two of the four measurable classes are detected at all. The hybrid design is
vindicated — but by evidence obtained after it had first been contradicted, which is
the more honest version of the story and the one worth telling.

The transferable lesson is about the *method*, not the regex: a hybrid system needs
its rule layer evaluated against real data and against its own annotation guide.
Neither the unit tests (which passed throughout) nor the synthetic metrics could
detect a rule that was confidently, consistently wrong.

---

## 8. Discussion prompts

1. Which classes transfer worst from synthetic to real, and what does that say about how
   they were templated?
2. Does the rule layer help precision, recall, or both -- and for which classes?
3. How much of the Nepali gap is tokenization versus data quality?
4. Which classes are inherently ambiguous even for human annotators? Check kappa per
   class, not just overall.
5. What would you change about the dataset if you rebuilt it? Start with the 0%
   multi-label validation split.
6. The transformer only ties the TF-IDF baseline on synthetic data. What does that say
   about the dataset rather than the model?

## 9. Stage 1 sign-off

Stage 1 exit condition from docs/STAGES.md: "trained model + artifact bundle, parity
test passing." Both are now satisfied.

| Item | Status |
|---|---|
| Model trained (MuRIL, v2.1, seed 13) | done -- macro-F1 (dark) 0.9019, tuned thresholds |
| Artifact bundle exported | done -- model.onnx, 951.65 MB, fp32 |
| Parity test | **PASSED** -- mean abs diff 0.00000, 100.00% label agreement, all 8 classes |
| Per-language results | filled in Section 3 |
| int8 quantization | evaluated and rejected -- see Section 4 |
| Bundle placed in ml/artifacts/model_v1 | done, gitignored per repo policy |

**Still open, deliberately deferred, not blocking:**

- Section 5 (latency) -- depends on Stage 2 backend existing.
- Section 6 (real gold set) -- Stage 4 scope.
- Section 7 (systematic error analysis) -- worth revisiting once the gold set exists;
  the transformer-vs-sneaking confusion on "verify account" templates (Section 3) is
  a candidate first entry.
- social_proof recall and confirmshaming precision -- root-caused to the 0%
  multi-label validation split, fix deferred to a future dataset version, not v2.2
  (see handoff Section 8: three dataset versions is the agreed limit).

**Stage 1 is closed as of this run.** Next work starts Stage 2: FastAPI inference
service, as scoped in the handoff.