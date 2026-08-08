# Dark Pattern Analyzer -- Handoff

**Purpose of this file.** Attach it, together with the project zip, at the start of a
fresh conversation. It contains everything needed to continue without re-reading any
chat history: what the project is, what has been measured, what is broken, what is
next, and every trap already paid for.

**Status: Stage 1 is code-complete and fully documented. The trained artifact bundle
was lost when the Colab session hit its GPU limit, so section 5 must be re-run once on
a fresh Google account. No code changes are required to do that.**

---

## 1. The project in one page

A multilingual, multi-label dark pattern detector for e-commerce pages, working in
**English, Hindi and Nepali**.

| Layer | Choice |
|---|---|
| Model | google/muril-base-cased, fine-tuned, multi-label |
| Serving | ONNX Runtime, fp32, inside FastAPI. No torch in the backend. |
| Backend | Python 3.12, uv, FastAPI, in-memory LRU cache |
| Frontend | Chrome extension (Manifest V3), WXT + React + TypeScript + Tailwind + shadcn/ui, closed shadow root |

**Eight labels, order frozen forever** (index order is baked into the ONNX output, the
thresholds file and every cache key):

```
confirmshaming, false_urgency, forced_action, obstruction,
scarcity, sneaking, social_proof, benign
```

The taxonomy follows Mathur et al. (2019), which makes it citable in the report.
Multi-label, not multi-class: one snippet can be both scarcity and false_urgency, so
training uses BCEWithLogitsLoss with sigmoid outputs and **per-class thresholds**.

### Four stages (docs/STAGES.md)

| Stage | Scope | Exit condition |
|---|---|---|
| 1 | Foundation and model | trained model + artifact bundle, parity test passing |
| 2 | Backend | FastAPI classifying text over HTTP |
| 3 | Frontend | Chrome extension working on live pages |
| 4 | Evaluation and release | real-site gold set, honest metrics, demo, presentable repo |

**Currently: end of Stage 1, blocked only on re-running the notebook.**

---

## 2. What was measured (full detail in docs/RESULTS.md)

### Base model choice was made on evidence

Tokenizer fertility, subword tokens per word (lower is better):

| Model | en | hi | ne | ne/en |
|---|---|---|---|---|
| distilbert-base-multilingual-cased | 1.504 | 2.196 | 2.937 | **1.95x** |
| **google/muril-base-cased** | 1.300 | 1.302 | 1.508 | **1.16x** |
| xlm-roberta-base | 1.406 | 1.540 | 1.705 | 1.21x |

mDistilBERT shreds Nepali. MuRIL was chosen against a 1.5x threshold fixed **before**
measuring. Cost: MuRIL's 197k vocabulary makes embeddings about 64% of its 236M
parameters, which is why the artifact is ~950 MB.

### Headline numbers, dataset v2.1, template-disjoint test

| | macro-F1 (7 dark) |
|---|---|
| TF-IDF baseline | 0.8987 |
| MuRIL, flat 0.5 threshold | 0.8280 |
| **MuRIL, tuned thresholds** | **0.9019** |

**The transformer only ties the baseline (+0.003). Say so in the report.** The honest,
defensible findings are:

1. Threshold tuning gained **+0.0739** -- more than the architecture did (+0.0032).
2. false_urgency gained **+0.083** (precision 0.756 to 0.908), and English gained
   +0.062. Those are precisely where hard negatives were added, so the hypothesis the
   dataset was built to test was confirmed.
3. Per-language spread fell from 0.074 to **0.0200** -- consistency matters more than a
   decimal place for a trilingual product.
4. Synthetic data is the ceiling. The Stage 4 gold set is the real test.

### Known weaknesses, already diagnosed

| Symptom | Cause | Status |
|---|---|---|
| social_proof recall 0.657 | validation split has 0% multi-label rows, test has 3.2%, so tuned thresholds are too low | documented, deferred |
| confirmshaming precision 0.878 | same cause; scored 1.000/1.000 on validation at threshold 0.11 | documented, deferred |
| leakage gap +0.0917 | random split shares template skeletons | reported as a finding |
| early stopping silently disabled | transformers 5.x could not find eval_macro_f1_dark | harmless at 3 epochs, worth a footnote |

---

## 3. Answer to the ONNX / int8 question, since it will come up again

The advice you were given elsewhere was **half right, and the wrong half is expensive.**

| Advice | Verdict |
|---|---|
| "Not a training problem, the model is fine" | **Correct** |
| "Skip int8, ship fp32" | **Correct, and it is now the default** |
| "opset_version=17 should be 18" | **Correct** -- 17 triggers a downgrade that corrupts shape metadata and causes the (768) vs (8) error |
| "Set dynamo=False, the legacy exporter is more stable" | **Wrong, and it silently corrupts the model** |

The legacy exporter traces the padding branch in transformers/masking_utils.py as a
**constant** at whatever sequence length the sample batch happened to have. The export
succeeds, the file is a normal single file, and the graph is silently wrong at every
other sequence length. dynamic_axes cannot undo an already-traced branch. That path was
tried and it produced a model that agreed with PyTorch on only 84% of labels.

Measured, 200 validation rows, PyTorch vs ONNX:

| Artifact | mean abs prob diff | label agreement | dark classes at 0 positives |
|---|---|---|---|
| **fp32, dynamo, opset 18** | **0.00000** | **100.00%** | **0 of 7** |
| int8, MatMul + embeddings | 0.09181 | 83.81% | 7 of 7 |
| int8, MatMul only | 0.09302 | 84.00% | 7 of 7 |
| int8, MatMul only, opset 18 | 0.09308 | 84.00% | 7 of 7 |

Excluding embeddings changed the result by 0.001, so int8 is simply not viable for this
model under this onnxruntime build. **fp32 is the decision. Do not reopen it.** The real
size fix is vocabulary pruning in Stage 4 (197k tokens to about 30k, roughly 200 MB).

**These are already fixed in the zip** -- ml/src/ml/export_onnx.py uses the dynamo
exporter at opset 18, inlines the external weight sidecar into a single self-contained
file, ships fp32 by default with int8 behind an opt-in --quantize flag, and records
"quantization": "fp32" in the manifest. Nothing further to change.

### The three traps, so they are not rediscovered

1. **The 0.1 MB model.onnx.** The dynamo exporter writes weights to an external .data
   sidecar. A parity test passes on the pointer file while the sidecar sits next to it,
   then the bundle breaks when moved. export_fp32 now inlines and asserts >50 MB.
2. **A perfect parity result can be a bug.** mean abs diff 0.00000 was first seen from a
   pointer file loading the sidecar from the same directory. Check the file size too.
3. **The smoke test cannot detect a destroyed model.** The int8 model printed
   scarcity 0.311 where fp32 prints 0.626. Plausible, and completely wrong. Only the
   parity test catches it.

**Reference smoke-test value: fp32 prints scarcity 0.626 on the built-in sample. If a
fresh export prints anything else, stop.**

---

## 4. What to do first, in order

### Step A -- push the repo (about 2 minutes)

The zip contains two files changed after your last push, plus filled documentation:

```bash
cd ~/Desktop/dark-pattern-analyzer
git status
git add -A
git commit -m "fix(onnx): export exact fp32 graph, drop int8 after parity failure

The dynamo exporter at opset 18 is numerically exact (parity 0.00000 / 100%).
Dynamic int8 collapsed all seven dark classes to zero positives in three
separate configurations, so fp32 is now the default and int8 is opt-in.
Fills docs/RESULTS.md with every measured number and adds docs/PROGRESS.md."
git push
```

### Step B -- new Google account (about 40 minutes, mostly waiting)

Nothing needs migrating. Code and data live in GitHub; the old checkpoints and the
stale artifact backup in the old Drive are both disposable.

1. Sign in to the new account. Open Colab, upload ml/notebooks/01_finetune_colab.ipynb,
   or open it from GitHub.
2. **Runtime > Change runtime type > T4 GPU.** Confirm before running anything.
3. Run sections 1 through 9 **in order, one cell at a time.** Do not use Run All.
4. Checkpoints now write to /content/dp_checkpoints, not Drive, so a full Drive cannot
   kill the run. Only the final bundle (section 9) touches Drive.
5. Expected checkpoints along the way:
   - section 2: MuRIL best on Nepali, and set MODEL_KEY = 'muril'
   - section 3: baseline macro-F1 dark about 0.8987
   - section 4: flat-0.5 macro-F1 about 0.83 -- **lower than the baseline is normal**,
     threshold tuning fixes it in section 5
   - section 5: tuned macro-F1 about 0.90
   - section 7: export prints scarcity 0.626
   - **section 8: PARITY TEST PASSED, 100.00%, mean abs diff 0.00000. Non-negotiable.**
6. Section 9 backs the bundle up to Drive and zips it. The zip is about 880 MB, so
   download it from drive.google.com rather than through the notebook, which stalls on
   large files.
7. Before the download finishes, delete /content/dp_checkpoints if Drive is tight.

**Do not re-run anything after section 9, and do not restart the runtime mid-run: the
trained weights live in /content and disappear with the session. That is exactly how
the previous bundle was lost.**

### Step C -- place the bundle and start Stage 2

```bash
cd ~/Desktop/dark-pattern-analyzer
unzip -o ~/Downloads/model_v1.zip -d ml/artifacts/
ls -la ml/artifacts/model_v1
```

Expect: model.onnx (~950 MB), tokenizer/, label_map.json, thresholds.json,
manifest.json, metrics.json, card.md. The bundle is gitignored -- **never commit it.**

Then fill in the per-language cells left blank in docs/RESULTS.md section 3 from
metrics.json, and Stage 1 is closed.

---

## 5. Stage 2 scope, already agreed

A production-ready FastAPI inference service: loads the ONNX model once in the lifespan
handler, multi-label prediction, clean REST API, pydantic-settings configuration,
structured logging, request validation, structured for deployment.

| Rule | Why |
|---|---|
| **backend/src/app/core/model_input.py must be byte-identical to build_model_input in ml/config.py** | any drift silently degrades every prediction; guard it with backend/tests/test_model_input.py |
| thresholds come from thresholds.json, never hardcoded | they carry +0.0739 macro-F1 |
| no torch in backend dependencies | onnxruntime is ~50 MB, torch is ~2.5 GB |
| model version in every cache key | prevents serving v1 predictions from a v2 model |
| container sized for ~950 MB fp32 | not the old int8 assumption |

Deferred deliberately: Redis (Stage 2 hardening), Postgres and /v1/feedback (Stage 4),
/v1/rules (late Stage 3), Next.js dashboard (Stage 4, cuttable).

---

## 6. Five invariants -- never violate

1. **Label order is frozen** exactly as listed in section 1.
2. **build_model_input stays byte-identical** across ml/ and backend/:
   `[TAG={tag}] [ROLE={role}] {text}`
3. **Thresholds always load from thresholds.json.**
4. **Model version appears in every cache key.**
5. **Never report split_random as a headline number** -- it leaks templates (+0.0917).

---

## 7. Repo layout and key configuration

```
dark-pattern-analyzer/
  backend/{src/app/{api/v1,core,schemas,services},tests}
  frontend/src/{entrypoints,lib,ui}
  data/{generator,gold,synthetic,synthetic_v2,synthetic_v2_1}
  docs/{ARCHITECTURE,PHASES,STAGES,SETUP,RESULTS,PROGRESS,DATASET_V2,ANNOTATION}.md
  ml/{notebooks,src/ml,artifacts,reports}
  Makefile  README.md  HANDOFF.md
```

ml/src/ml/: config, dataset, metrics, tokenizer_fertility, baseline, train,
tune_thresholds, evaluate, export_onnx, parity_test.

Frozen configuration (ml/src/ml/config.py):

```
max_length=64            batch_size=32         epochs=3
learning_rate=3e-5       weight_decay=0.01     warmup_ratio=0.1
seed=13                  fp16=True             text_column="model_input"
problem_type="multi_label_classification"
DEFAULT_PROFILE="precision"   SPLIT_PRIMARY="split_template_disjoint"
```

Datasets: v1 27,000 rows · v2 28,483 (1,483 hard negatives) · **v2.1 28,450, current**.
v2.1 text and splits are byte-identical to v2; only 549 labels changed and 33 rows were
dropped. Set DATA to data/synthetic_v2_1.

Useful commands:

```bash
make data-check DATA=data/synthetic_v2_1    # run from the repo root, not from ml/
cd ml && uv sync
```

Expected v2.1 guard output: 17,394 train / 4,638 val / 6,418 test raw, 17 duplicate
texts dropped, all guards passed. The 17 duplicates are benign-versus-benign and
harmless.

---

## 8. Open questions to settle in the new chat

1. The seven CSV files named at the very start (dark_pattern_*.csv) were never actually
   attached. Were they synthetic or scraped from real sites? **If scraped, they are the
   seed for the Stage 4 gold set**, which is the most valuable missing piece.
2. Gold set annotation: solo, or a second annotator for a Cohen's kappa figure? A kappa
   number materially strengthens the report.
3. docs/RESULTS.md section 3 per-language cells and section 5 latency are still blank
   pending the re-run and Stage 2.

### Small pending cleanups, none blocking

- Remove the `{NUM_BIG} verified reviews` hard-negative template (index 00, all three
  languages) from data/generator/hardneg_templates_a.py -- it collides with social_proof.
- Append a v2.1 section to docs/DATASET_V2.md.
- **Do not build a v2.2.** Three dataset versions is the agreed limit.

---

## 9. Working preferences that were established the hard way

- Give a decision, not a menu of options. State the reason in one line.
- Do not patch code on a hypothesis. Measure first, then patch.
- Do not add scope that was not asked for.
- Do not re-run a 35-minute job without enumerating exactly what would change.
- Every deliverable ships as one zip, never a drip of loose files mid-run.
- Everything gets documented, in plain language, in docs/.
