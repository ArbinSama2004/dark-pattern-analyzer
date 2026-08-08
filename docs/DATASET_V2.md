# Dataset v2 -- adversarial hard negatives

**Why this exists.** The v1 baseline scored **0.9586 macro-F1** with a TF-IDF character n-gram model. That number was not leakage -- the template-disjoint split was verified honest -- but it was uninformative, because the classes were almost lexically disjoint and the benign class never imitated dark-pattern wording. v2 fixes the benchmark, not the model.

v1 is preserved unchanged in `data/synthetic/`. v2 lives in `data/synthetic_v2/`. Both are reproducible; the comparison is the result.

---

## 1. What was wrong with v1

### Classes had exclusive vocabularies

Share of word occurrences made up of words appearing in that class **and nowhere else** (English train rows):

| Class | Exclusive-word mass | Giveaway words |
|---|---|---|
| confirmshaming | **42.3%** | `i`, `don't`, `paying`, `fine`, `more` |
| sneaking | **32.5%** | `charge`, `fee`, `month`, `handling` |
| obstruction | **26.2%** | `contact`, `through`, `write`, `must` |
| social_proof | 19.9% | `bought`, `shoppers`, `customers` |
| forced_action | 17.4% | `register`, `unlock`, `trial` |
| scarcity | 10.1% | `warehouse`, `low`, `hurry` |
| false_urgency | 6.9% | `expires`, `countdown` |

`confirmshaming` and `obstruction` scored a perfect 1.000 precision *and* recall. The word `contact` appeared in obstruction and in no other class, so the task reduced to keyword lookup. Note that the two classes with the lowest exclusive-word mass -- `scarcity` (10.1%) and `false_urgency` (6.9%) -- were also the two weakest classes (0.841 and 0.983 F1). That correlation is the mechanism.

### The benign class contained no near-misses

```
benign rows containing "left" / "stock" / "remaining" / "only":  0 / 440
```

Zero. Yet real e-commerce uses this language legitimately all the time:

- "Only 3 left in stock" -- a genuine inventory display
- "1,024 people bought this last month" -- a real statistic
- "Sale ends Sunday" -- a real deadline
- "No thanks" -- a neutral decline button

These are precisely the cases that generate **false positives** in deployment, and v1's test set contained none of them. The model was never asked to distinguish *manipulative* scarcity from *factual* inventory -- the single most important discrimination in the problem.

---

## 2. What v2 adds

**1,483 benign rows** that deliberately borrow each dark class's vocabulary while describing something legitimate.

| Designed to confuse | en | hi | ne | Example (en) |
|---|---|---|---|---|
| `scarcity` | 100 | 100 | 100 | "Only 3 left in stock" |
| `sneaking` | 100 | 100 | 100 | "Delivery fee Rs. 60, shown before payment" |
| `social_proof` | 100 | 100 | 100 | "1,024 verified reviews" |
| `false_urgency` | 65 | 62 | 66 | "Coupon expires in 7 days" |
| `forced_action` | 42 | 43 | 49 | "Enter your PIN code to check delivery" |
| `obstruction` | 43 | 47 | 46 | "Cancel anytime in Settings" |
| `confirmshaming` | 40 | 40 | 40 | "No thanks" |

All are labelled `benign`. The class they target is recorded in the `source` column as `hard_negative_v2:<class>`, so per-group error analysis is possible.

### Why some groups are smaller

The target was 100 per group, but four groups fell short **for a legitimate reason**: their phrasings are slot-free. "No thanks" has no `{PRODUCT}` or `{PRICE}` to vary, so it cannot yield 100 distinct strings. Rather than pad with duplicates, the builder varies the structural context (`tag`, `role`), which is real signal because `model_input` encodes it. Real decline buttons genuinely have few phrasings, so this reflects the domain rather than distorting it.

---

## 3. v2 composition

| | v1 | v2 |
|---|---|---|
| Total rows | 27,000 | **28,483** |
| Benign positives | 6,000 | **7,483** |
| Dark-class positives | unchanged | unchanged |
| Templates | 714 | **924** |

**`split_template_disjoint`:**

| Part | v2 total | v1 rows | hard negatives |
|---|---|---|---|
| train | 17,427 | 16,508 | 919 |
| val | 4,638 | 4,361 | 277 |
| test | 6,418 | 6,131 | 287 |

Hard-negative templates use their own namespace (`hardneg:<class>:<lang>:<idx>`) and are split by template at ~60/15/25, so template disjointness still holds. v1 rows keep their original assignment, which means **v1's test set is a strict subset of v2's** -- the two differ only by the added hard negatives.

> The loader still drops the 4 known cross-part duplicate texts at load time, so v2's test set loads as 6,414 rows.

---

## 4. What to expect

| Metric | v1 | v2 (predicted) |
|---|---|---|
| Baseline macro-F1 (dark) | 0.9586 | **0.78-0.88** |
| `scarcity` F1 | 0.841 | **lower** |
| `confirmshaming` F1 | 1.000 | **well below 1.000** |
| `obstruction` F1 | 1.000 | **well below 1.000** |
| Benign precision | 0.967 | **lower** |

The baseline *should* fall. Keyword lookup stops working once `contact` appears in both obstruction and benign text. If it does not fall, the hard negatives are not hard enough and need revisiting.

MuRIL should hold substantially higher than the v2 baseline, because word order and context are what separate "Only 3 left, order now before it's gone!" from "Only 3 left in stock". **That gap is the actual result of this project** -- direct evidence that contextual understanding beats lexical matching on this task. v1 could not produce that evidence, because it left the transformer nothing to demonstrate.

---

## 5. Reproducing

```bash
cd data/generator
python3 build_v2.py
```

Deterministic (`SEED = 13`). Reads `data/synthetic/`, writes `data/synthetic_v2/`, never modifies v1.

| File | Contents |
|---|---|
| `hardneg_templates_a.py` | scarcity, false_urgency, social_proof counterparts |
| `hardneg_templates_b.py` | confirmshaming, obstruction, forced_action, sneaking |
| `build_v2.py` | Generation, template-disjoint splitting, merge with v1 |

---

## 6. Reporting both versions

Report v1 **and** v2. The progression is the methodological contribution:

> An initial character n-gram baseline reached 0.96 macro-F1 on held-out templates. Inspection showed the classes had near-disjoint vocabularies (42% of confirmshaming word mass was class-exclusive) and that no benign example used dark-pattern vocabulary legitimately. We therefore added 1,483 adversarial hard negatives. The baseline fell to X, while the fine-tuned model reached Y -- isolating the contribution of contextual understanding.

An examined 0.85 is stronger evidence of competence than an unexamined 0.96.

---

## 7. Limitation

These hard negatives are still **synthetic and template-generated**. They fix a specific, diagnosed weakness -- absent lexical overlap between benign and dark classes -- but they do not remove the synthetic-to-real distribution gap. The Stage 4 gold set of hand-annotated snippets from live sites remains the only honest measure of real-world performance, and is still expected to land well below the synthetic score.
