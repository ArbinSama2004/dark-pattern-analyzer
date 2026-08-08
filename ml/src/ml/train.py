"""Multi-label fine-tuning of a multilingual transformer.

    uv run python -m ml.train --data ../data/synthetic --out ../ml/artifacts/model_v1

Design notes
------------
* **Multi-label, not multi-class.** ``problem_type="multi_label_classification"``
  makes HuggingFace use ``BCEWithLogitsLoss`` with sigmoid outputs. Softmax
  would force a single winner, which is wrong: "Only 3 left, ends in 10:00" is
  genuinely both scarcity and false urgency.
* **Trains on the template-disjoint split.** Enforced by assertion in
  ``dataset.py`` -- the random split cannot be selected by accident.
* **Early stopping on val ``macro_f1_dark``**, not loss. Loss keeps improving
  while the model memorises template skeletons.
* **Checkpoints to Drive when on Colab.** Colab will disconnect, and it will
  happen deep into a run.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np

from ml.config import (
    CANDIDATE_MODELS,
    LABELS,
    NUM_LABELS,
    SPLIT_PRIMARY,
    ArtifactManifest,
    Paths,
    TrainConfig,
)
from ml.dataset import class_support, labels_matrix, load_all_parts
from ml.metrics import hf_compute_metrics


def _on_colab() -> bool:
    return "COLAB_GPU" in os.environ or Path("/content").exists()


def set_seed_everywhere(seed: int) -> None:
    import random

    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def build_datasets(parts: dict, cfg: TrainConfig, tokenizer):
    from datasets import Dataset

    def prep(df):
        ds = Dataset.from_dict(
            {
                "text": df[cfg.text_column].tolist(),
                "labels": labels_matrix(df).tolist(),  # float32 multi-hot
            }
        )
        return ds.map(
            lambda b: tokenizer(
                b["text"],
                truncation=True,
                max_length=cfg.max_length,
                padding=False,  # dynamic padding via collator is faster
            ),
            batched=True,
            remove_columns=["text"],
        )

    return {name: prep(df) for name, df in parts.items()}


def train(
    data_root: str,
    out_dir: str,
    cfg: TrainConfig,
    model_key: str | None = None,
) -> dict:
    import torch
    from transformers import (
        AutoModelForSequenceClassification,
        AutoTokenizer,
        DataCollatorWithPadding,
        EarlyStoppingCallback,
        Trainer,
        TrainingArguments,
    )

    if model_key:
        if model_key not in CANDIDATE_MODELS:
            raise SystemExit(f"Unknown model key {model_key!r}. Options: {list(CANDIDATE_MODELS)}")
        cfg.model_name = CANDIDATE_MODELS[model_key]

    set_seed_everywhere(cfg.seed)
    paths = Paths()
    ckpt_root = paths.drive_checkpoints if _on_colab() else paths.checkpoints
    ckpt_root.mkdir(parents=True, exist_ok=True)

    print(f"Base model : {cfg.model_name}")
    print(f"Split      : {SPLIT_PRIMARY} (template-disjoint)")
    print(f"Text column: {cfg.text_column}")
    print(f"Device     : {'cuda' if torch.cuda.is_available() else 'cpu'}")
    print(f"Checkpoints: {ckpt_root}")

    parts = load_all_parts(data_root, SPLIT_PRIMARY)
    print("\nLabel support in train:")
    print(class_support(parts["train"]).to_string())

    tokenizer = AutoTokenizer.from_pretrained(cfg.model_name)
    ds = build_datasets(parts, cfg, tokenizer)

    model = AutoModelForSequenceClassification.from_pretrained(
        cfg.model_name,
        num_labels=NUM_LABELS,
        problem_type=cfg.problem_type,  # -> BCEWithLogitsLoss + sigmoid
        id2label={i: lab for i, lab in enumerate(LABELS)},
        label2id={lab: i for i, lab in enumerate(LABELS)},
    )

    use_fp16 = cfg.fp16 and torch.cuda.is_available()
    args = TrainingArguments(
        output_dir=str(ckpt_root),
        num_train_epochs=cfg.epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.eval_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        weight_decay=cfg.weight_decay,
        warmup_ratio=cfg.warmup_ratio,
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_strategy="steps",
        logging_steps=50,
        load_best_model_at_end=True,
        metric_for_best_model=cfg.metric_for_best_model,
        greater_is_better=True,
        save_total_limit=1,  # each MuRIL checkpoint is ~950 MB of Drive quota
        fp16=use_fp16,
        seed=cfg.seed,
        report_to=[],  # no wandb prompt in Colab
        dataloader_num_workers=2,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=ds["train"],
        eval_dataset=ds["val"],
        data_collator=DataCollatorWithPadding(tokenizer),
        compute_metrics=hf_compute_metrics,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=cfg.early_stopping_patience)],
    )

    print("\nTraining ...")
    trainer.train()

    print("\nValidation (flat 0.5 threshold -- tuned per class next):")
    val_metrics = trainer.evaluate(ds["val"])
    for k, v in val_metrics.items():
        if isinstance(v, float):
            print(f"  {k}: {v:.4f}")

    print("\nTest (flat 0.5 threshold):")
    test_metrics = trainer.evaluate(ds["test"], metric_key_prefix="test")
    for k, v in test_metrics.items():
        if isinstance(v, float):
            print(f"  {k}: {v:.4f}")

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(out / "pytorch"))
    tokenizer.save_pretrained(str(out / "tokenizer"))

    ArtifactManifest(
        base_model=cfg.model_name,
        max_length=cfg.max_length,
        text_column=cfg.text_column,
        quantized=False,  # set True by export_onnx.py
        dataset=str(data_root).rstrip('/').split('/')[-1],
    ).write(out)

    (out / "train_metrics.json").write_text(
        json.dumps(
            {
                "base_model": cfg.model_name,
                "split": SPLIT_PRIMARY,
                "dataset": str(data_root).rstrip("/").split("/")[-1],
                "epochs_configured": cfg.epochs,
                "val": {k: v for k, v in val_metrics.items() if isinstance(v, float)},
                "test_flat_threshold": {
                    k: v for k, v in test_metrics.items() if isinstance(v, float)
                },
                "note": "Flat 0.5 threshold. See metrics.json for tuned per-class results.",
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    print(f"\nSaved to {out}")
    print("Next: uv run python -m ml.tune_thresholds")
    return {"val": val_metrics, "test": test_metrics, "out": str(out)}


def main() -> int:
    ap = argparse.ArgumentParser(description="Fine-tune the dark pattern classifier")
    ap.add_argument("--data", default="../data/synthetic")
    ap.add_argument("--out", default="../ml/artifacts/model_v1")
    ap.add_argument(
        "--model",
        default=None,
        choices=list(CANDIDATE_MODELS),
        help="base model key; default from config (mdistilbert)",
    )
    ap.add_argument("--epochs", type=int, default=None)
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--max-length", type=int, default=None)
    args = ap.parse_args()

    cfg = TrainConfig()
    if args.epochs:
        cfg.epochs = args.epochs
    if args.batch_size:
        cfg.batch_size = args.batch_size
    if args.lr:
        cfg.learning_rate = args.lr
    if args.max_length:
        cfg.max_length = args.max_length

    train(args.data, args.out, cfg, args.model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
