# `ml/` — Training and Export

Everything needed to turn `data/synthetic/` into a deployable ONNX model.

**This package is not part of the deployed service.** It depends on `torch` and
`transformers` (~2.5 GB). The backend depends only on `onnxruntime` and `tokenizers`
(~120 MB) and never imports from here. The interface between them is the artifact
bundle in `artifacts/model_v1/`, nothing more.

---

## Quickstart

```bash
uv sync
uv run python -m ml.dataset --check --data ../data/synthetic   # validate first
uv run python -m ml.tokenizer_fertility --data ../data/synthetic
```

The intended path is the Colab notebook — `notebooks/01_finetune_colab.ipynb` — which
calls into these same modules. Local CPU training is possible but slow (hours rather
than minutes).

---

## Modules

| Module | Purpose |
|---|---|
| `config.py` | **Frozen label order**, paths, hyperparameters, threshold profiles |
| `dataset.py` | Loading plus the leakage guards |
| `tokenizer_fertility.py` | Compares how badly each tokenizer fragments each language |
| `baseline.py` | TF-IDF char n-grams + one-vs-rest logistic regression |
| `train.py` | Multi-label fine-tuning via HF `Trainer` |
| `tune_thresholds.py` | Per-class decision thresholds on validation |
| `evaluate.py` | Macro-F1, per-class, per-language, confusion analysis |
| `export_onnx.py` | ONNX export plus dynamic int8 quantization |
| `parity_test.py` | Asserts PyTorch and ONNX agree |

Run order: `dataset` → `tokenizer_fertility` → `baseline` → `train` →
`tune_thresholds` → `evaluate` → `export_onnx` → `parity_test`.

Or just `make model` from the repo root.

---

## Four decisions worth understanding

### 1. Multi-label, not multi-class

`BCEWithLogitsLoss` with sigmoid outputs and per-class thresholds — not softmax.

> *"Only 3 left — offer ends in 10:00"*

That is **scarcity and false urgency simultaneously**. Softmax forces a choice between
them and would train the model to suppress one true label. About 2.7% of the dataset is
multi-label, and those rows are the realistic ones.

### 2. `model_input`, not `text`

Training consumes `[TAG=button] [ROLE=cancel] No thanks, I'll pay full price`.

Structural context carries real signal. *"No thanks"* inside a paragraph is ordinary
prose; on a cancel-role button next to a bright confirm button, it is confirmshaming.
Withholding the tag and role would throw that away.

The cost: **the backend must construct this string identically.** `build_model_input()`
in `config.py` and `core/model_input.py` in the backend must never diverge. The backend
has a dedicated test for this, because feature skew fails silently.

### 3. Macro-F1 over the seven dark classes, excluding `benign`

`benign` is the largest class (6,000 rows) and by far the easiest. Including it in the
headline metric inflates the number and hides the failures that matter. It is still
reported separately.

### 4. Report the template-disjoint split only

Both splits ship. `split_random` exists **solely to quantify leakage**.

Because the data is template-generated, a random split places rows sharing a skeleton on
both sides. Expect roughly **+15 macro-F1** on the random split. That gap is memorisation,
not learning. `dataset.py` hard-asserts template disjointness so the honest path cannot
be taken by accident.

---

## Choosing the base model

`tokenizer_fertility.py` runs before any training, and it can change your answer.

**Fertility** = subword tokens per whitespace word. Higher means the tokenizer is
shredding the language, so the model sees fragments instead of morphemes and burns
sequence length on noise.

| Model | Params | Role |
|---|---|---|
| `distilbert-base-multilingual-cased` | 135M | **Default primary** — fast, deployable, direct analogue of the paper |
| `google/muril-base-cased` | 236M | Indic specialist; **pretrained on Nepali explicitly** |
| `xlm-roberta-base` | 278M | Strongest general multilingual; upper-bound reference |
| `Multilingual-MiniLM-L12-H384` | 118M | Smallest; choose if going in-browser |

**Decision rule:** if mDistilBERT's Nepali fertility exceeds roughly **1.5×** MuRIL's,
switch the primary to MuRIL and keep mDistilBERT as a documented comparison. Write the
numbers into `docs/RESULTS.md` either way — Nepali tokenizer coverage is a legitimate
finding, not busywork.

**Never `distilbert-base-uncased`.** It lowercases and strips accents, destroying
Devanagari.

---

## On overfitting

The common worry is that 1,000 samples per class per language is too few. That is not
where the risk lies.

With 27,000 rows across 714 templates, the real risk is **memorising templates**. More
samples from the same templates would not help; it would inflate your metrics while
making them less true. What controls overfitting here is:

1. **How you split** — templates held out, enforced by assertion
2. **Early stopping** on val macro-F1, patience 2
3. **Few epochs** — 3 is usually right; 10 will memorise
4. **The real gold set in Stage 4** — the only honest verdict

A large train/test gap on the template-disjoint split means genuine overfitting. A large
gap between the two *splits* means your data is template-heavy — which it is, by
construction, and which is exactly why Stage 4 exists.

---

## Artifact bundle

Stage 1 must hand Stage 2 exactly this:

```
artifacts/model_v1/
├── model.onnx        # int8 dynamic quantized
├── tokenizer/        # the tokenizer actually trained with
├── label_map.json    # frozen index → label
├── thresholds.json   # per-class, per-profile
├── manifest.json     # base model, max_length, version, text_column
├── metrics.json      # both splits, per class, per language
└── card.md           # model card
```

The backend reads `label_map.json` and `thresholds.json` at startup. Neither is ever
hardcoded, so retraining requires no backend code change — only a `DP_MODEL_VERSION`
bump, which invalidates the cache.
