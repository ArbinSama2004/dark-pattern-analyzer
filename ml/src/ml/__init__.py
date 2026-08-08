"""Dark Pattern Analyzer -- training, evaluation and export.

This package is used only at training time. The deployed backend consumes the
artifact bundle it produces (``model.onnx`` + ``tokenizer/`` +
``label_map.json`` + ``thresholds.json``) and never imports from here.

Run order::

    python -m ml.dataset --check
    python -m ml.tokenizer_fertility
    python -m ml.baseline
    python -m ml.train
    python -m ml.tune_thresholds
    python -m ml.evaluate
    python -m ml.export_onnx
    python -m ml.parity_test
"""

__version__ = "0.1.0"

from ml.config import DARK_LABELS, LABELS, LANGS, NUM_LABELS, TrainConfig

__all__ = ["LABELS", "DARK_LABELS", "LANGS", "NUM_LABELS", "TrainConfig", "__version__"]
