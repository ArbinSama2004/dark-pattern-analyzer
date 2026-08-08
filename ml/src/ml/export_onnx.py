"""Export the fine-tuned model to ONNX and quantize to int8.

    uv run python -m ml.export_onnx --artifacts ../ml/artifacts/model_v1

Why ONNX instead of shipping PyTorch
------------------------------------
1. **Dependency weight.** The API needs ``onnxruntime`` (~50 MB) instead of
   ``torch`` (~2.5 GB). That is the difference between a container that deploys
   comfortably on a free tier and one that does not.
2. **Cold-start latency.** ONNX Runtime loads in tens of milliseconds where
   PyTorch takes seconds.
3. **CPU throughput.** ONNX Runtime's graph optimisations beat eager PyTorch on
   CPU, typically by 2-4x for short sequences like ours.

Why dynamic int8 quantization
-----------------------------
Roughly 4x smaller weights and 2-3x faster CPU inference, usually costing well
under one F1 point. "Dynamic" means activations are quantized on the fly, so no
calibration dataset is needed.

**But it can silently break one class.** That is not hypothetical -- it happens,
and nothing raises an error. ``parity_test.py`` exists for exactly this reason
and must be run afterwards. Every time.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from ml.config import LABELS, NUM_LABELS, TrainConfig


def export_fp32(artifacts: Path, cfg: TrainConfig) -> Path:
    """Trace the PyTorch model to an fp32 ONNX graph with dynamic axes."""
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    src = artifacts / "pytorch"
    if not src.exists():
        raise SystemExit(f"No trained model at {src}. Run ml.train first.")

    tok = AutoTokenizer.from_pretrained(str(artifacts / "tokenizer"))
    model = AutoModelForSequenceClassification.from_pretrained(str(src))
    model.eval()

    dest = artifacts / "model_fp32.onnx"

    # A representative dummy batch. Shapes are dynamic, so exact sizes here do
    # not constrain runtime batch size or sequence length.
    sample = tok(
        ["[TAG=button] [ROLE=cancel] No thanks", "[TAG=span] [ROLE=none] Only 3 left"],
        return_tensors="pt",
        padding="max_length",
        truncation=True,
        max_length=cfg.max_length,
    )

    input_names = ["input_ids", "attention_mask"]
    inputs = (sample["input_ids"], sample["attention_mask"])

    # BERT-family models (MuRIL, XLM-R via BertModel) take token_type_ids;
    # DistilBERT does not. Include it only when the tokenizer emits it.
    if "token_type_ids" in sample:
        input_names.append("token_type_ids")
        inputs = (sample["input_ids"], sample["attention_mask"], sample["token_type_ids"])

    dynamic_axes = {name: {0: "batch", 1: "sequence"} for name in input_names}
    dynamic_axes["logits"] = {0: "batch"}

    print(f"Exporting fp32 ONNX -> {dest}")
    print(f"  inputs: {input_names}")
    torch.onnx.export(
        model,
        inputs,
        str(dest),
        input_names=input_names,
        output_names=["logits"],
        dynamic_axes=dynamic_axes,
        opset_version=17,
        do_constant_folding=True,
    )

    (artifacts / "onnx_inputs.json").write_text(json.dumps(input_names, indent=2), encoding="utf-8")
    print(f"  size: {dest.stat().st_size / 1e6:.1f} MB")
    return dest


def quantize_int8(fp32_path: Path, artifacts: Path) -> Path:
    """Dynamic int8 quantization of the linear layers."""
    from onnxruntime.quantization import QuantType, quantize_dynamic

    dest = artifacts / "model.onnx"
    print(f"\nQuantizing int8 -> {dest}")
    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(dest),
        weight_type=QuantType.QInt8,
        extra_options={"MatMulConstBOnly": True},
    )
    before = fp32_path.stat().st_size / 1e6
    after = dest.stat().st_size / 1e6
    print(f"  {before:.1f} MB -> {after:.1f} MB  ({before / after:.1f}x smaller)")
    return dest


def verify_loads(onnx_path: Path, artifacts: Path, cfg: TrainConfig) -> None:
    """Smoke test: the graph loads and emits the right output shape."""
    import numpy as np
    import onnxruntime as ort
    from transformers import AutoTokenizer

    print(f"\nSmoke-testing {onnx_path.name} ...")
    sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    tok = AutoTokenizer.from_pretrained(str(artifacts / "tokenizer"))

    expected = {i.name for i in sess.get_inputs()}
    enc = tok(
        ["[TAG=span] [ROLE=none] Only 2 left in stock!"],
        return_tensors="np",
        truncation=True,
        max_length=cfg.max_length,
        padding=True,
    )
    feed = {k: v.astype(np.int64) for k, v in enc.items() if k in expected}

    logits = sess.run(None, feed)[0]
    print(f"  graph inputs : {sorted(expected)}")
    print(f"  output shape : {logits.shape}")
    if logits.shape[-1] != NUM_LABELS:
        raise SystemExit(f"Expected {NUM_LABELS} outputs, got {logits.shape[-1]}")

    probs = 1 / (1 + np.exp(-logits[0]))
    print("  sample probabilities:")
    for lab, p in sorted(zip(LABELS, probs, strict=True), key=lambda x: -x[1])[:3]:
        print(f"    {lab:<16} {p:.3f}")


def write_card(artifacts: Path, cfg: TrainConfig) -> None:
    """Seed the model card from whatever metrics exist."""
    metrics_path = artifacts / "metrics.json"
    headline = "not yet evaluated"
    per_lang = ""
    if metrics_path.exists():
        blob = json.loads(metrics_path.read_text(encoding="utf-8"))
        prim = blob.get("primary", {})
        if prim:
            headline = f"{prim['summary']['macro_f1_dark']:.4f} macro-F1 (7 dark classes)"
            per_lang = "\n".join(
                f"| {lang} | {m['n']} | {m['macro_f1_dark']:.4f} |"
                for lang, m in prim.get("per_language", {}).items()
            )

    manifest = {}
    mp = artifacts / "manifest.json"
    if mp.exists():
        manifest = json.loads(mp.read_text(encoding="utf-8"))

    (artifacts / "card.md").write_text(
        f"""# Model Card - Dark Pattern Analyzer

## Overview

| | |
|---|---|
| Base model | `{manifest.get("base_model", cfg.model_name)}` |
| Task | Multi-label text classification, 8 classes |
| Languages | English, Hindi, Nepali |
| Version | {manifest.get("model_version", "1.0.0")} |
| Format | ONNX, dynamic int8 |
| Max sequence length | {manifest.get("max_length", cfg.max_length)} |
| Input format | `{manifest.get("text_column", cfg.text_column)}` |

## Labels

{chr(10).join(f"{i}. `{lab}`" for i, lab in enumerate(LABELS))}

Multi-label with sigmoid outputs and per-class thresholds. A snippet may carry
several labels: *"Only 3 left, ends in 10:00"* is scarcity **and** false urgency.

## Results (synthetic, template-disjoint test split)

**{headline}**

{"| Language | n | macro-F1 (dark) |" + chr(10) + "|---|---|---|" + chr(10) + per_lang if per_lang else "_Run `ml.evaluate` to populate._"}

## Training data

27,000 synthetic snippets generated from 714 templates across three languages.
1,000 per manipulative class per language; 2,000 benign per language. Generator
code is committed in `data/generator/` for full reproducibility.

## Intended use

Research and educational analysis of potentially manipulative interface patterns
on e-commerce websites. Outputs are **heuristic signals for human review**, not
legal determinations.

## Limitations

- **Trained on synthetic data.** Real-world phrasing is more varied and messier.
  Expect materially lower performance on live sites; see `docs/RESULTS.md` for
  the measured gold-set gap.
- **Nepali is the weakest language.** Nepali is under-represented in multilingual
  pretraining corpora.
- **Short snippets only.** Text beyond {manifest.get("max_length", cfg.max_length)}
  tokens is truncated.
- **No visual reasoning.** Colour contrast, size and position asymmetry are
  handled by the deterministic rule layer, not this model.
- **Not a legal tool.** Never presents output as a finding of illegality.

## Ethical considerations

All user-facing copy says "potentially manipulative pattern". False positives
can unfairly damage a business's reputation, which is why the default threshold
profile optimises for precision over recall.
""",
        encoding="utf-8",
    )
    print(f"Wrote {artifacts / 'card.md'}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Export to ONNX and quantize")
    ap.add_argument("--artifacts", default="../ml/artifacts/model_v1")
    ap.add_argument("--keep-fp32", action="store_true", help="keep the fp32 graph for debugging")
    ap.add_argument("--no-quantize", action="store_true", help="ship fp32 (use if int8 hurts)")
    args = ap.parse_args()

    artifacts = Path(args.artifacts)
    cfg = TrainConfig()
    mp = artifacts / "manifest.json"
    if mp.exists():
        cfg.max_length = json.loads(mp.read_text(encoding="utf-8")).get("max_length", cfg.max_length)

    fp32 = export_fp32(artifacts, cfg)

    if args.no_quantize:
        shutil.copy(fp32, artifacts / "model.onnx")
        final = artifacts / "model.onnx"
        print("\nSkipped quantization; shipping fp32.")
    else:
        final = quantize_int8(fp32, artifacts)

    verify_loads(final, artifacts, cfg)

    if mp.exists():
        blob = json.loads(mp.read_text(encoding="utf-8"))
        blob["quantized"] = not args.no_quantize
        mp.write_text(json.dumps(blob, indent=2), encoding="utf-8")

    write_card(artifacts, cfg)

    if not args.keep_fp32 and not args.no_quantize:
        fp32.unlink(missing_ok=True)
        print(f"Removed {fp32.name} (pass --keep-fp32 to retain it)")

    print("\n" + "!" * 68)
    print("NOW RUN THE PARITY TEST:")
    print("  uv run python -m ml.parity_test --artifacts " + args.artifacts)
    print("")
    print("int8 quantization can destroy a single class while everything else")
    print("looks fine, and it raises no error. The parity test is the only check.")
    print("!" * 68)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
