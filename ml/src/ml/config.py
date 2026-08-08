"""Single source of truth for label order, paths and training defaults.

EVERY component reads label order from here (and, at serving time, from the
exported ``label_map.json``). Never hardcode a label list anywhere else: if the
order drifts between training and inference, every prediction becomes silently
wrong and nothing crashes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Label contract -- FROZEN. Do not reorder.
# ---------------------------------------------------------------------------

LABELS: list[str] = [
    "confirmshaming",
    "false_urgency",
    "forced_action",
    "obstruction",
    "scarcity",
    "sneaking",
    "social_proof",
    "benign",
]

#: The seven manipulative classes. ``benign`` is excluded: it is the negative
#: class and including it in macro-F1 inflates the headline number, because it
#: is both the largest and by far the easiest class.
DARK_LABELS: list[str] = [lab for lab in LABELS if lab != "benign"]

LABEL_TO_ID: dict[str, int] = {lab: i for i, lab in enumerate(LABELS)}
ID_TO_LABEL: dict[int, str] = {i: lab for lab, i in LABEL_TO_ID.items()}
NUM_LABELS: int = len(LABELS)

#: One-hot column names as written by the dataset generator.
Y_COLS: list[str] = [f"y_{lab}" for lab in LABELS]

LANGS: list[str] = ["en", "hi", "ne"]

# ---------------------------------------------------------------------------
# Candidate base models
# ---------------------------------------------------------------------------

#: Evaluated by ``tokenizer_fertility.py``. The winner becomes the primary
#: model; the others stay in the report as documented comparisons.
#:
#: ``distilbert-base-uncased`` is absent on purpose -- it strips accents and
#: lowercases, which mangles Devanagari beyond recovery.
CANDIDATE_MODELS: dict[str, str] = {
    "mdistilbert": "distilbert-base-multilingual-cased",
    "muril": "google/muril-base-cased",
    "xlmr": "xlm-roberta-base",
    "minilm": "microsoft/Multilingual-MiniLM-L12-H384",
}

DEFAULT_MODEL: str = CANDIDATE_MODELS["mdistilbert"]

# ---------------------------------------------------------------------------
# Splits
# ---------------------------------------------------------------------------

#: The split to train and report on. Templates are disjoint across train/val/
#: test, so the model cannot pass by memorising phrasings.
SPLIT_PRIMARY: str = "split_template_disjoint"

#: Kept only to quantify the leakage gap. Roughly +15 macro-F1 versus the
#: template-disjoint split. NEVER report this as your headline result.
SPLIT_LEAKY: str = "split_random"


@dataclass
class TrainConfig:
    """Fine-tuning hyperparameters. Defaults are tuned for a free Colab T4."""

    model_name: str = DEFAULT_MODEL
    max_length: int = 64  # snippets are short; 64 covers >99% of rows
    batch_size: int = 32
    eval_batch_size: int = 64
    epochs: int = 3
    learning_rate: float = 3e-5
    weight_decay: float = 0.01
    warmup_ratio: float = 0.1
    seed: int = 13
    fp16: bool = True  # T4 supports it; roughly halves training time
    gradient_accumulation_steps: int = 1

    #: Multi-label, so BCEWithLogitsLoss + sigmoid. Not softmax:
    #: "Only 3 left - sale ends in 10:00" is scarcity AND false_urgency.
    problem_type: str = "multi_label_classification"

    #: Use ``model_input`` (with [TAG=..] [ROLE=..] prefixes) rather than raw
    #: ``text``. Structural context is a genuine signal: "No thanks" on a
    #: cancel-role button reads very differently from the same words in a
    #: paragraph.
    text_column: str = "model_input"

    label_smoothing: float = 0.0
    early_stopping_patience: int = 2
    metric_for_best_model: str = "eval_macro_f1_dark"


@dataclass
class Paths:
    """Filesystem layout. All paths resolve relative to the repo root."""

    data_root: Path = Path("../data/synthetic")
    artifacts: Path = Path("../ml/artifacts/model_v1")
    checkpoints: Path = Path("./checkpoints")
    reports: Path = Path("./reports")

    #: Colab only. Mount Drive and checkpoint there -- Colab disconnects, and
    #: it will happen 40 minutes into a run.
    # Colab checkpoints live on local disk, NOT Drive. save_total_limit=1 keeps one
    # checkpoint, but a full Drive still killed a run mid-training. Only the final
    # artifact bundle is copied to Drive, in section 9 of the notebook.
    drive_checkpoints: Path = Path("/content/dp_checkpoints")

    def split_dir(self, split: str = SPLIT_PRIMARY) -> Path:
        return self.data_root / split

    def ensure(self) -> None:
        for p in (self.artifacts, self.checkpoints, self.reports):
            p.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Threshold profiles
# ---------------------------------------------------------------------------

#: Starting points only -- real values are tuned per class on validation by
#: ``tune_thresholds.py`` and shipped in ``thresholds.json``.
#:
#: ``precision`` is the recommended default for the extension. A false positive
#: is far more damaging than a miss: telling a user an honest site is
#: manipulating them destroys trust in the tool immediately.
THRESHOLD_PROFILES: dict[str, float] = {
    "precision": 0.70,
    "balanced": 0.50,
    "recall": 0.35,
}

DEFAULT_PROFILE: str = "precision"


@dataclass
class ArtifactManifest:
    """What Stage 1 must hand to Stage 2. Written to the artifacts dir."""

    model_version: str = "1.0.0"
    base_model: str = DEFAULT_MODEL
    labels: list[str] = field(default_factory=lambda: list(LABELS))
    max_length: int = 64
    text_column: str = "model_input"
    quantized: bool = True
    # Which dataset directory trained this bundle (e.g. "synthetic_v2_1").
    # The directory name model_v1 is a RELEASE version, not a data version,
    # so the data provenance has to be recorded explicitly.
    dataset: str = "unknown"

    def write(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)
        (path / "label_map.json").write_text(
            json.dumps(
                {"labels": self.labels, "label_to_id": LABEL_TO_ID},
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (path / "manifest.json").write_text(
            json.dumps(
                {
                    "model_version": self.model_version,
                    "base_model": self.base_model,
                    "max_length": self.max_length,
                    "text_column": self.text_column,
                    "quantized": self.quantized,
                    "dataset": self.dataset,
                },
                indent=2,
            ),
            encoding="utf-8",
        )


def build_model_input(text: str, tag: str = "span", role: str = "none") -> str:
    """Build the model input string.

    This MUST stay byte-identical to the backend's ``core/model_input.py``.
    Any divergence is feature skew: the model sees a different string shape at
    serving time than it saw in training, accuracy silently degrades, and no
    test fails. The backend has a dedicated guard test for exactly this.
    """
    return f"[TAG={tag}] [ROLE={role}] {text}"
