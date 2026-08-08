# Results

> **Template.** Fill this in as Stage 1 completes. These tables are what your report
> and README quote, so record numbers as you get them rather than reconstructing them
> later.

---

## 1. Tokenizer fertility

From `make fertility` (section 2 of the Colab notebook). Subword tokens per word --
lower is better.

| Model | en | hi | ne | ne/en ratio |
|---|---|---|---|---|
| `distilbert-base-multilingual-cased` | | | | |
| `google/muril-base-cased` | | | | |
| `xlm-roberta-base` | | | | |
| `Multilingual-MiniLM-L12-H384` | | | | |

Model chosen: google/muril-base-cased

Reason: mDistilBERT fragments Nepali 1.95× worse than MuRIL (2.937 vs 1.508 tokens/word), exceeding the pre-registered 1.5× switching threshold. MuRIL also leads on Hindi and English with zero UNK.


> Decision rule: if mDistilBERT's Nepali fertility exceeds ~1.5x MuRIL's, MuRIL becomes
> primary. Record the reason either way -- this is a genuine finding about Nepali
> tokenizer coverage, and reviewers notice evidence-based choices.

---

## 2. Baseline

TF-IDF character n-grams (2-5) + one-vs-rest logistic regression.

| Split | macro-F1 (7 dark classes) | micro-F1 | exact match |
|---|---|---|---|
| template-disjoint test | | | |
| random test | | | |

**Leakage gap:** _____ macro-F1

> The gap is memorisation of template skeletons, not learning. Quoting it is evidence
> of methodological care.

---

## 3. Fine-tuned model

**Template-disjoint test, precision threshold profile.**

| Metric | Value |
|---|---|
| macro-F1 (7 dark classes) | |
| micro-F1 | |
| exact match | |
| improvement over baseline | |

### Per class

| Class | threshold | precision | recall | F1 | support |
|---|---|---|---|---|---|
| `confirmshaming` | | | | | |
| `false_urgency` | | | | | |
| `forced_action` | | | | | |
| `obstruction` | | | | | |
| `scarcity` | | | | | |
| `sneaking` | | | | | |
| `social_proof` | | | | | |
| `benign` * | | | | | |

\* excluded from macro-F1

### Per language

| Language | n | macro-F1 (dark) |
|---|---|---|
| en | | |
| hi | | |
| ne | | |

**Spread:** _____

> If Nepali lags by more than 0.10, revisit section 1 and consider MuRIL.

### Threshold profile comparison

| Profile | macro-F1 | macro-precision | macro-recall |
|---|---|---|---|
| `precision` | | | |
| `balanced` | | | |
| `recall` | | | |

---

## 4. Quantization

| | fp32 | int8 |
|---|---|---|
| size (MB) | | |
| macro-F1 | | |

**Parity test:** PASS / FAIL · label agreement _____ · mean |dp| _____

---

## 5. Latency (Stage 2)

| Stage | p50 | p95 | budget |
|---|---|---|---|
| extraction (in-page) | | | 20 ms |
| rules (in-page) | | | 10 ms |
| network round trip | | | 25 ms |
| inference, batch of 32 | | | 40 ms |
| **total** | | | **100 ms** |

---

## 6. Real-site gold set (Stage 4)

**The honest evaluation.** Hand-annotated snippets from live sites.

| | Value |
|---|---|
| sites | |
| snippets | |
| annotators | |
| Cohen's kappa (100-item overlap) | |

| Metric | synthetic test | real gold | gap |
|---|---|---|---|
| macro-F1 (dark) | | | |

> **Expect roughly 0.90 -> 0.65-0.75.** That drop is the finding, not a failure. It
> quantifies the synthetic-to-real distribution shift, which is exactly the limitation
> a reviewer will ask about. Reporting it with per-class analysis is stronger work than
> a suspiciously clean 0.99.

### Per class on real data

| Class | precision | recall | F1 | support | notes |
|---|---|---|---|---|---|
| | | | | | |

### Rule-layer ablation

| Configuration | macro-F1 | precision | recall |
|---|---|---|---|
| model only | | | |
| model + rules | | | |

---

## 7. Error analysis

### False positives (categorised)

| Pattern | Count | Example | Why it fires |
|---|---|---|---|
| | | | |

### False negatives (categorised)

| Pattern | Count | Example | Why it is missed |
|---|---|---|---|
| | | | |

---

## 8. Discussion prompts

Answer these in the report:

1. Which classes transfer worst from synthetic to real, and what does that say about
   how they were templated?
2. Does the rule layer help precision, recall, or both -- and for which classes?
3. How much of the Nepali gap is tokenization versus data quality?
4. Which classes are inherently ambiguous even for human annotators? (Check kappa per
   class, not just overall.)
5. What would you change about the dataset if you rebuilt it?
