# Setup Guide

How to get from a fresh clone to a trained model sitting in `ml/artifacts/model_v1/`,
and then to a running backend.

---

## 0. Prerequisites

| Tool | Version | Install |
|---|---|---|
| Python | 3.12 | via `uv python install 3.12` |
| uv | latest | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Node | 20+ | for the Stage 3 extension |
| pnpm | 9+ | `npm i -g pnpm` |
| Google account | — | for Colab (free T4 is sufficient) |

`uv` replaces `pip`, `venv`, `pip-tools` and `pyenv`. You never activate a virtualenv by
hand; `uv run <cmd>` resolves the right environment automatically.

---

## 1. Clone and verify the environment

```bash
git clone <your-repo-url> dark-pattern-analyzer
cd dark-pattern-analyzer

# training environment (torch, transformers) — heavy, ~2.5 GB
cd ml && uv sync && cd ..

# check
cd ml && uv run python -c "import torch, transformers; print(torch.__version__, transformers.__version__)" && cd ..
```

The backend has a **separate, much lighter** dependency set (`onnxruntime`, no torch).
That separation is deliberate: your deployed service should not carry a 2.5 GB training
stack. See `docs/ARCHITECTURE.md` §8.

---

## 2. Confirm the dataset

```bash
cd ml
uv run python -c "
import pandas as pd
d = pd.read_csv('../data/synthetic/dataset_all.csv')
print('rows:', len(d))
print('languages:', sorted(d.lang.unique()))
print(d.groupby(['primary_label','lang']).size().unstack())
print('duplicate (text,lang):', d.duplicated(['text','lang']).sum())
"
```

Expected: 27,000 rows · `['en','hi','ne']` · 1000 per dark class per language · 2000
benign per language · **0** duplicates.

---

## 3. Train in Colab

### 3.1 Get the code and data into Colab

**Option A — clone (recommended).** In the first notebook cell:

```python
!git clone https://github.com/<you>/dark-pattern-analyzer.git
%cd dark-pattern-analyzer/ml
```

**Option B — upload.** Zip `ml/` and `data/synthetic/`, upload via the Files pane, unzip.
Slower and easier to get wrong; prefer A.

### 3.2 Enable the GPU

`Runtime → Change runtime type → Hardware accelerator → T4 GPU`. Verify:

```python
import torch; print(torch.cuda.get_device_name(0))
```

A free T4 fine-tunes this dataset in roughly 10–20 minutes for 3 epochs.

### 3.3 Mount Drive for checkpoints

**Do this.** Colab disconnects, usually at the least convenient moment.

```python
from google.colab import drive
drive.mount('/content/drive')
```

The notebook writes checkpoints to `/content/drive/MyDrive/dp_checkpoints/`.

### 3.4 Run `ml/notebooks/01_finetune_colab.ipynb` top to bottom

Sections, in order:

| § | What it does | Why it matters |
|---|---|---|
| 1 | Environment and dataset checks | Fail fast on bad inputs |
| 2 | **Tokenizer fertility comparison** | Decides your base model on evidence |
| 3 | Baseline: TF-IDF char n-grams + logreg | The floor all later numbers beat |
| 4 | Fine-tune the chosen transformer | The actual model |
| 5 | Per-class threshold tuning on val | Replaces a naive global 0.5 |
| 6 | Evaluation: macro-F1, per-class, per-language | Your results tables |
| 7 | ONNX export + int8 quantization | Serving format |
| 8 | Parity test | Catches quantization damage |
| 9 | Bundle and download artifacts | Handover to Stage 2 |

**Do not skip §2.** It takes about ten minutes and it can change which model you train.
If `distilbert-base-multilingual-cased` fragments Nepali substantially worse than
`google/muril-base-cased` (more than roughly 1.5× the subwords per word), MuRIL becomes
your primary model and mDistilBERT becomes a documented baseline. Write the numbers
down either way — it is a genuine finding about Nepali NLP, not a chore.

**Do not skip §8.** Dynamic int8 quantization occasionally collapses one class while
everything else looks fine. The parity test is the only thing that catches it.

---

## 4. Bring the artifacts into VS Code

The final notebook cell produces `model_v1.zip`. Then, locally:

```bash
unzip ~/Downloads/model_v1.zip -d ml/artifacts/
ls ml/artifacts/model_v1/
```

Expected contents:

```
ml/artifacts/model_v1/
├── model.onnx          # int8 quantized, ~35–70 MB
├── tokenizer/          # tokenizer.json, special_tokens_map.json, config
├── thresholds.json     # per-class decision thresholds, per profile
├── label_map.json      # frozen index → label order
├── metrics.json        # macro-F1, per-class, per-language, both splits
└── card.md             # training data, limits, intended use
```

### Verify locally before touching the backend

```bash
cd ml
uv run python -m ml.parity_test --artifacts artifacts/model_v1 --n 200
```

### What must be true

| File | Non-negotiable |
|---|---|
| `label_map.json` | Index order **identical** to training. If it drifts, every prediction is silently wrong and nothing crashes. |
| `thresholds.json` | Loaded at runtime, never copied into code |
| `tokenizer/` | The tokenizer of the model you actually trained, not a re-download |

---

## 5. Commit artifacts, or don't

`model.onnx` is tens of megabytes. Options:

| Approach | When |
|---|---|
| Git LFS | Cleanest for a portfolio repo you want to be clonable |
| GitHub Release asset | Good: repo stays light, artifact is versioned and linked |
| `.gitignore` + download script | Lightest, but a fresh clone cannot run without a fetch step |

For a major-project repo, a **Release asset** reads best: reviewers see a tagged
`model_v1` with metrics in the release notes.

Do commit `metrics.json`, `thresholds.json`, `label_map.json` and `card.md` regardless.
They are small, and they are the evidence.

---

## 6. Point the backend at the artifacts (Stage 2)

```bash
cd backend
cp .env.example .env
```

```ini
DP_MODEL_DIR=../ml/artifacts/model_v1
DP_MODEL_VERSION=1.0.0
DP_THRESHOLD_PROFILE=precision
```

`DP_MODEL_VERSION` is part of every cache key. If you retrain and forget to bump it,
the cache serves old predictions indefinitely and you will lose an afternoon to it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Nepali F1 far below English | Tokenizer fragmentation | Revisit §2; try MuRIL |
| Macro-F1 ≥ 0.99 on template-disjoint | Leakage | Re-check the `template_id` disjointness assertion |
| ONNX and PyTorch labels differ | Quantization damage | Export fp32; compare per class |
| Colab OOM | Batch too large | Drop to 16, or `gradient_accumulation_steps=2` |
| `uv sync` resolution failure | Python version | `uv python install 3.12` |
| One class always predicted | Threshold collapse | Inspect `thresholds.json`; check class support in val |
