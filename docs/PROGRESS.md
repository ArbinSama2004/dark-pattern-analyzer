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

### 5. Artifact loss and re-run

The Colab session hit its GPU limit before the bundle was downloaded, so the trained
weights are gone. Code and data are safe in GitHub. Stage 1 must be re-run once on a
fresh Google account -- about 40 minutes, no code changes needed. See HANDOFF.md.

Mitigation applied: checkpoints now write to /content/dp_checkpoints instead of Google
Drive, so a full Drive can no longer kill a run mid-training. Only the final bundle
touches Drive.

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

## Known open items

| Item | Priority | Stage |
|---|---|---|
| Validation split has 0% multi-label rows while test has 3.2%, distorting tuned thresholds | high | 4 |
| Real-site gold set not collected -- the honest evaluation | high | 4 |
| MuRIL vocabulary pruning, 197k to about 30k, target roughly 200 MB | medium | 4 |
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
