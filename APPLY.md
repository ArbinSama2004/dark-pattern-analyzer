# ONNX export fix -- what is in this zip and how to apply it

Two files, both replacements for files already in your repo:

| File | What changed |
|---|---|
| `ml/src/ml/export_onnx.py` | dynamo exporter at opset 18, sidecar weights inlined automatically, fp32 by default, int8 only via `--quantize`, manifest records `"quantization"`, model card reads the real format |
| `ml/notebooks/01_finetune_colab.ipynb` | section 7 exports fp32 and writes `dataset` + `quantization` into the manifest; sections 0, 7 and 8 document the measured int8 failure |

## Apply on your Mac (NOT in Colab)

```bash
cd ~/Desktop/dark-pattern-analyzer
unzip -o ~/Downloads/onnx_export_fix.zip
git status                      # expect exactly 2 modified files
git add ml/src/ml/export_onnx.py ml/notebooks/01_finetune_colab.ipynb
git commit -m "fix(onnx): export exact fp32 graph, drop int8 after parity failure"
git push
```

Do not `git pull` inside your live Colab session. Python has already imported
`ml.export_onnx`, so a pull cannot replace it in memory, and restarting the
session would delete your trained `ml/artifacts/model_v1/pytorch/` directory.
Finish the current run with the cell in the chat, then use this notebook next time.

## Why int8 was dropped

200 validation rows, PyTorch vs ONNX:

| Artifact | mean abs prob diff | label agreement | dark classes at 0 positives |
|---|---|---|---|
| fp32 | 0.00000 | 100.00% | 0 of 7 |
| int8, MatMul + embeddings | 0.09181 | 83.81% | 7 of 7 |
| int8, MatMul only | 0.09302 | 84.00% | 7 of 7 |
| int8, MatMul only, opset 18 | 0.09308 | 84.00% | 7 of 7 |

Excluding embeddings changed nothing, so it is not a tuning problem. The
artifact is ~950 MB fp32. Vocabulary pruning in Stage 4 is the real fix.
