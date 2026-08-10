# Model Card — Dark Pattern Analyzer v1.0.0

The hand-written card. A shorter one is generated into
`ml/artifacts/model_v1/card.md` by `ml.export_onnx` at export time; that file
records what the exporter actually produced and should not be edited by hand.
Where the two disagree, the generated file is right about the *artifact* and this
file is right about the *project*.

---

## Overview

| | |
|---|---|
| Base model | `google/muril-base-cased` (236M parameters) |
| Task | Multi-label text classification, 8 classes |
| Languages | English, Hindi, Nepali |
| Version | 1.0.0 |
| Format | ONNX, **fp32** (~950 MB) |
| Max sequence length | 64 tokens |
| Training data | `synthetic_v2_1`, 28,450 rows |
| Split reported | template-disjoint |
| Threshold profile shipped | `precision` |

## Labels

Frozen order — it is baked into the ONNX output axis, `thresholds.json` and every
cache key. Reordering it silently remaps every prediction.

`confirmshaming`, `false_urgency`, `forced_action`, `obstruction`, `scarcity`,
`sneaking`, `social_proof`, `benign`

Sigmoid outputs with per-class thresholds, not softmax. A snippet may carry several
labels: *"Only 3 left, ends in 10:00"* is scarcity **and** false urgency.

`benign` is the eighth output and its score is returned for transparency, but it is
never used as a veto and is excluded from the headline macro-F1 — it is the largest
and easiest class, and including it inflates the number.

## Why MuRIL

Chosen on measurement taken **before** any training, against a 1.5x switching
threshold fixed in advance. mDistilBERT fragments Nepali 1.95x worse than MuRIL
(2.937 vs 1.508 subword tokens per word).

The cost was accepted knowingly: MuRIL's 197k-token vocabulary makes the embedding
table roughly 64% of its parameters, which drives both the ~950 MB artifact and the
quantization failure below.

## Results — synthetic, template-disjoint test

**macro-F1 (7 dark classes): 0.9019**

| Language | macro-F1 (dark) |
|---|---|
| en | 0.8891 |
| hi | 0.9054 |
| ne | 0.9091 |

Full per-class tables: [`RESULTS.md`](RESULTS.md) §3.

### Read this before quoting the headline

The TF-IDF character n-gram baseline scores **0.8987** on the same split. The
transformer's margin is **+0.0032**, which is a tie, not a win, and the write-up
should say so.

The defensible claims are narrower and more interesting:

- **Threshold tuning was worth more than the architecture**: +0.0739 versus +0.0032.
- **The transformer wins where context matters**: `false_urgency` +0.083, with
  precision moving 0.756 → 0.908 — the class most confused by the hard negatives
  that were added specifically to test this.
- **It is far more consistent across languages**: per-language spread fell from
  0.074 to 0.0200. For a trilingual tool that matters more than a decimal place.

## Quantization: int8 was attempted and rejected

Dynamic int8 was tried in three configurations. Every time it **collapsed all seven
manipulative classes to zero positive predictions**, while the smoke test kept
printing plausible-looking probabilities (`scarcity` 0.311 against fp32's 0.626).
Excluding the embedding table changed the outcome by 0.001.

Only the parity test caught this. Nothing raised an exception; the export succeeded
and the model loaded. **fp32 ships.** The real size fix is vocabulary pruning, not
quantization.

## Latency

| Case | p50 | p95 |
|---|---:|---:|
| inference, batch of 32 | 618 ms | 653 ms |
| inference, batch of 1 | 15.0 ms | 16.4 ms |

Measured with `make bench` on Apple Silicon, CPU only. The project's original budget
was 40 ms for a batch of 32; that budget assumed int8. This model misses it by
roughly 16x, and a 600-candidate page therefore needs 12+ seconds of pure inference.
See [`RESULTS.md`](RESULTS.md) §5 for what would actually change it.

## Intended use

Research and educational analysis of potentially manipulative interface patterns on
e-commerce websites. Outputs are **heuristic signals for human review, not legal
determinations.**

Deployed as one half of a hybrid: this model reads wording, and a separate layer of
eleven deterministic rules reads structure (mutation cadence, checkbox state, computed
contrast, bounding boxes). Neither is sufficient alone — a language model cannot see
that a timer resets on reload.

## Limitations

- **The headline 0.9019 is synthetic.** On a 400-snippet real-site sample the model
  alone scores **0.394** macro-F1 over the classes present; **with the rule layer it
  reaches 0.717** (see [`RESULTS.md`](RESULTS.md) §6). Quote the figure that matches
  what you are describing — the shipped product is the hybrid.
- **That real-site evaluation is a silver set, not a gold set.** Its labels were
  assigned by an LLM against the annotation guide, blinded to model output but not
  independent of it in the way human judgement would be. Treat real-site figures as
  preliminary.
- **The rule layer initially *hurt* on real pages** (−0.134 macro-F1) because
  `stock_counter` treated `"N sold"` as scarcity while the annotation guide treats a
  settled sale count as benign. Fixed: the rule no longer matches bare sale counts,
  and a narrow `recent_activity` rule now handles the recency-bounded phrasing that
  genuinely is dark. Contribution is now **+0.323**. The episode is documented in
  [`RESULTS.md`](RESULTS.md) §7 rather than erased, because it is the clearest
  evidence in the project for why real-site evaluation was necessary.
- **The dataset is templated**, so it under-represents the messiness of real
  phrasing. This is why the template-disjoint split is the only one reported: the
  random split scores 0.99 by letting the model memorise skeletons.
- **`social_proof` is the weakest class** (F1 0.773, recall 0.657) and is also the
  class where the labelling rule is hardest to apply consistently — the boundary
  between "unverifiable live activity" and "settled verifiable aggregate" is
  genuinely subtle. See [`ANNOTATION.md`](ANNOTATION.md).
- **Largest remaining false-positive group**: `"Gems save Rs. N"` classified
  `sneaking`, 46 occurrences, model-only. Arguable — a human annotator might agree
  with the model here — and it is the single judgement most affecting the headline.
- **Nepali remains unevaluated on real pages.** Only 3 of 400 real snippets were
  Devanagari and none contained a dark pattern, so real-site per-language results do
  not exist. Multilingual coverage is this project's central claim and it is
  currently supported by synthetic data alone.
- **Short snippets only.** Text beyond 64 tokens is truncated. p95 of the training
  data was 34 tokens, so this is generous for UI microcopy and wrong for prose.
- **No visual reasoning.** Colour, size and position are the rule layer's job.
- **Hindi and Nepali share Devanagari**, and nothing in the pipeline distinguishes
  them by script alone. Language is taken from the page, not detected.
- **Not a legal tool.** It never presents output as a finding of illegality, and
  that constraint is enforced in code as well as in wording.

## Ethical considerations

All user-facing copy says "potentially manipulative pattern". False positives can
unfairly damage a business's reputation, which is why the shipped threshold profile
optimises for precision over recall, and why the `recall` profile — which drives
`social_proof` precision to 0.155 — exists only for experiments and is documented as
unsafe to ship.

## Reproducing

```bash
make data-check       # dataset shape and leakage guards
make model            # baseline -> train -> thresholds -> evaluate -> export -> parity
make smoke-backend    # must print scarcity=0.626
```

Training runs in `ml/notebooks/01_finetune_colab.ipynb` (~40 minutes on a T4).
Seed 13. The generator that produced the dataset is committed in `data/generator/`.
