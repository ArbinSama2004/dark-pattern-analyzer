"""Assert the exported ONNX model agrees with the PyTorch model it came from.

    uv run python -m ml.parity_test --artifacts ../ml/artifacts/model_v1 --n 200

Run this after EVERY export. No exceptions.

What it catches
---------------
Dynamic int8 quantization occasionally collapses one class -- a label that
scored 0.85 F1 in PyTorch starts predicting all-negative in ONNX. Nothing throws
an exception. The API starts up cleanly, returns well-formed responses, and is
quietly wrong about one of your eight classes.

The alternative to this test is discovering the problem during your
demonstration, or not at all.

What "passing" means
--------------------
* Label agreement >= 99% at the tuned thresholds
* Mean absolute probability difference < 0.02
* No class where ONNX predicts a positive rate far below PyTorch's

If it fails, re-export with ``--no-quantize`` and compare. If fp32 passes, int8
is the culprit: either accept the larger model or quantize selectively.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from ml.config import LABELS, SPLIT_PRIMARY, TrainConfig
from ml.dataset import load_split
from ml.metrics import apply_thresholds, sigmoid
from ml.tune_thresholds import predict_logits


def onnx_logits(artifacts: Path, texts: list[str], cfg: TrainConfig, batch: int = 32) -> np.ndarray:
    import onnxruntime as ort
    from transformers import AutoTokenizer

    sess = ort.InferenceSession(
        str(artifacts / "model.onnx"), providers=["CPUExecutionProvider"]
    )
    expected = {i.name for i in sess.get_inputs()}
    tok = AutoTokenizer.from_pretrained(str(artifacts / "tokenizer"))

    out = []
    for i in range(0, len(texts), batch):
        enc = tok(
            texts[i : i + batch],
            return_tensors="np",
            truncation=True,
            max_length=cfg.max_length,
            padding=True,
        )
        feed = {k: v.astype(np.int64) for k, v in enc.items() if k in expected}
        out.append(sess.run(None, feed)[0])
    return np.vstack(out)


def load_thresholds(artifacts: Path, profile: str = "precision") -> dict[str, float]:
    path = artifacts / "thresholds.json"
    if not path.exists():
        return dict.fromkeys(LABELS, 0.5)
    return json.loads(path.read_text(encoding="utf-8"))["profiles"][profile]["thresholds"]


def run(artifacts: Path, data_root: str, n: int, profile: str) -> bool:
    cfg = TrainConfig()
    mp = artifacts / "manifest.json"
    if mp.exists():
        cfg.max_length = json.loads(mp.read_text(encoding="utf-8")).get("max_length", cfg.max_length)

    val = load_split(data_root, SPLIT_PRIMARY, "val")
    sample = val.sample(n=min(n, len(val)), random_state=13)
    texts = sample[cfg.text_column].tolist()

    print(f"Comparing PyTorch vs ONNX on {len(texts)} validation rows ...\n")
    pt = sigmoid(predict_logits(artifacts, texts, cfg))
    ox = sigmoid(onnx_logits(artifacts, texts, cfg))

    thresholds = load_thresholds(artifacts, profile)
    pt_pred = apply_thresholds(pt, thresholds)
    ox_pred = apply_thresholds(ox, thresholds)

    mean_abs = float(np.abs(pt - ox).mean())
    max_abs = float(np.abs(pt - ox).max())
    agreement = float((pt_pred == ox_pred).mean())
    row_agreement = float((pt_pred == ox_pred).all(axis=1).mean())

    print(f"mean |dp|            : {mean_abs:.5f}   (want < 0.02)")
    print(f"max  |dp|            : {max_abs:.5f}")
    print(f"label agreement      : {agreement:.4%}  (want >= 99%)")
    print(f"full-row agreement   : {row_agreement:.4%}")

    print(f"\n{'label':<17}{'pt pos':>9}{'onnx pos':>10}{'agree':>9}{'mean |dp|':>11}")
    print("-" * 56)
    failures: list[str] = []
    for i, lab in enumerate(LABELS):
        pt_pos = int(pt_pred[:, i].sum())
        ox_pos = int(ox_pred[:, i].sum())
        agree = float((pt_pred[:, i] == ox_pred[:, i]).mean())
        drift = float(np.abs(pt[:, i] - ox[:, i]).mean())
        flag = ""
        if agree < 0.97:
            flag = "  <-- DISAGREES"
            failures.append(f"{lab}: only {agree:.2%} label agreement")
        if pt_pos >= 5 and ox_pos < pt_pos * 0.5:
            flag = "  <-- COLLAPSED"
            failures.append(f"{lab}: ONNX positives {ox_pos} vs PyTorch {pt_pos}")
        print(f"{lab:<17}{pt_pos:>9}{ox_pos:>10}{agree:>9.2%}{drift:>11.5f}{flag}")

    if mean_abs >= 0.02:
        failures.append(f"mean absolute probability difference {mean_abs:.4f} >= 0.02")
    if agreement < 0.99:
        failures.append(f"label agreement {agreement:.2%} < 99%")

    print("\n" + "=" * 68)
    if failures:
        print("PARITY TEST FAILED\n")
        for f in failures:
            print(f"  - {f}")
        print("\nWhat to do:")
        print("  1. Re-export with --no-quantize and re-run this test.")
        print("  2. If fp32 passes, int8 quantization is the cause.")
        print("  3. Either ship fp32, or exclude the affected layers from")
        print("     quantization via nodes_to_exclude.")
        print("  4. Do NOT proceed to Stage 2 until this passes.")
        print("=" * 68)
        return False

    print("PARITY TEST PASSED")
    print("\nThe ONNX artifact faithfully reproduces the trained model.")
    print("Stage 1 is complete. The artifact bundle is ready for the backend.")
    print("=" * 68)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="PyTorch vs ONNX parity check")
    ap.add_argument("--artifacts", default="../ml/artifacts/model_v1")
    ap.add_argument("--data", default="../data/synthetic")
    ap.add_argument("--n", type=int, default=200, help="validation rows to compare")
    ap.add_argument("--profile", default="precision")
    args = ap.parse_args()

    artifacts = Path(args.artifacts)
    if not (artifacts / "model.onnx").exists():
        raise SystemExit(f"No {artifacts / 'model.onnx'}. Run ml.export_onnx first.")

    return 0 if run(artifacts, args.data, args.n, args.profile) else 1


if __name__ == "__main__":
    raise SystemExit(main())
