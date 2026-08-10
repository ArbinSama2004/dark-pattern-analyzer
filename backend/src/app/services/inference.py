"""ONNX inference engine.

One session for the whole process, created in the FastAPI lifespan handler.
Creating it per request costs 200-500 ms and is the most common way to blow the
<100 ms budget, so ``InferenceEngine`` is built exactly once and held on
``app.state``.

The tokenizer is the ``tokenizers`` fast tokenizer loaded straight from
``tokenizer/tokenizer.json``. That is deliberate: pulling in ``transformers`` just
to call ``AutoTokenizer`` would drag ~2.5 GB of torch into a serving image that
otherwise needs ~120 MB. The tokenizer.json in the bundle is the same file
transformers would have read, so the token ids are identical.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np

from app.core.bundle import Bundle
from app.services.postprocess import sigmoid

log = logging.getLogger(__name__)

#: The reference smoke input and expected scarcity probability, from Stage 1's
#: export_onnx.verify_loads and docs/RESULTS.md. A destroyed graph (int8 collapse,
#: pointer-file weights) still loads and still returns well-formed numbers, so a
#: fixed expected value is the only cheap way to notice at startup.
SMOKE_TEXT = "[TAG=span] [ROLE=none] Only 2 left in stock!"
SMOKE_LABEL = "scarcity"
SMOKE_EXPECTED = 0.626
#: Generous: CPU vs GPU export and ORT version differences move the third decimal.
#: A collapsed model misses by ~0.3, which this catches easily.
SMOKE_TOLERANCE = 0.05


class InferenceError(RuntimeError):
    """Raised when the ONNX graph cannot be loaded or disagrees with the contract."""


@dataclass
class SmokeResult:
    passed: bool
    label: str
    observed: float
    expected: float
    tolerance: float

    def message(self) -> str:
        verdict = "ok" if self.passed else "FAILED"
        return (
            f"smoke check {verdict}: {self.label}={self.observed:.3f} "
            f"(expected {self.expected:.3f} +/- {self.tolerance:.3f})"
        )


class InferenceEngine:
    """Wraps the ONNX session and the tokenizer. Not created per request."""

    def __init__(self, bundle: Bundle, *, max_batch: int = 64, intra_op_threads: int = 0) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.bundle = bundle
        self.max_batch = max_batch

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if intra_op_threads > 0:
            options.intra_op_num_threads = intra_op_threads

        started = time.perf_counter()
        self._session = ort.InferenceSession(
            str(bundle.onnx_path),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )
        load_ms = (time.perf_counter() - started) * 1000
        log.info(
            "loaded ONNX session from %s in %.0f ms (%.1f MB, %s)",
            bundle.onnx_path,
            load_ms,
            bundle.onnx_path.stat().st_size / 1e6,
            bundle.quantization,
        )

        #: Only feed inputs the graph actually declares. MuRIL is BERT-style and
        #: wants token_type_ids; a different base model may not have them.
        self._graph_inputs = {i.name for i in self._session.get_inputs()}
        outputs = self._session.get_outputs()
        if not outputs:
            raise InferenceError(f"{bundle.onnx_path} declares no outputs")
        self._output_name = outputs[0].name

        declared = outputs[0].shape
        last_dim = declared[-1] if declared else None
        if isinstance(last_dim, int) and last_dim != len(bundle.labels):
            raise InferenceError(
                f"graph output has {last_dim} classes but the label contract has "
                f"{len(bundle.labels)}. Refusing to serve a permuted label axis."
            )

        self._tokenizer = Tokenizer.from_file(str(bundle.tokenizer_path))
        self._tokenizer.enable_truncation(max_length=bundle.max_length)
        pad_id = self._tokenizer.token_to_id("[PAD]")
        if pad_id is None:
            raise InferenceError(f"{bundle.tokenizer_path} has no [PAD] token; cannot batch safely")
        # Pad to the longest row in each batch, not to max_length. The graph has
        # dynamic sequence axes, and short UI microcopy means most batches are far
        # under 64 tokens -- padding to 64 every time wastes most of the compute.
        self._tokenizer.enable_padding(pad_id=pad_id, pad_token="[PAD]", direction="right")

    # -- properties --------------------------------------------------------

    @property
    def labels(self) -> tuple[str, ...]:
        return self.bundle.labels

    @property
    def graph_inputs(self) -> set[str]:
        return set(self._graph_inputs)

    # -- inference ---------------------------------------------------------

    def _encode(self, texts: list[str]) -> dict[str, np.ndarray]:
        encodings = self._tokenizer.encode_batch(texts)
        feed: dict[str, np.ndarray] = {
            "input_ids": np.asarray([e.ids for e in encodings], dtype=np.int64),
            "attention_mask": np.asarray([e.attention_mask for e in encodings], dtype=np.int64),
            "token_type_ids": np.asarray([e.type_ids for e in encodings], dtype=np.int64),
        }
        return {k: v for k, v in feed.items() if k in self._graph_inputs}

    def predict_probs(self, texts: list[str]) -> tuple[np.ndarray, float]:
        """Return ``(probs, inference_ms)`` for already-built model input strings.

        ``texts`` must already be ``[TAG=..] [ROLE=..] ..`` strings; this method
        does not build them, so there is exactly one place that does.
        """
        if not texts:
            return np.zeros((0, len(self.labels)), dtype=np.float64), 0.0

        chunks: list[np.ndarray] = []
        elapsed_ms = 0.0
        for start in range(0, len(texts), self.max_batch):
            batch = texts[start : start + self.max_batch]
            feed = self._encode(batch)
            began = time.perf_counter()
            logits = self._session.run([self._output_name], feed)[0]
            elapsed_ms += (time.perf_counter() - began) * 1000
            logits = np.asarray(logits)
            if logits.ndim != 2 or logits.shape[1] != len(self.labels):
                raise InferenceError(
                    f"unexpected logits shape {logits.shape}; expected (batch, {len(self.labels)})"
                )
            chunks.append(sigmoid(logits))

        return np.concatenate(chunks, axis=0), elapsed_ms

    # -- startup checks ----------------------------------------------------

    def smoke_check(self) -> SmokeResult:
        """Run Stage 1's reference input and compare against the known value.

        This is not a substitute for the parity test -- the notebook is explicit
        that a smoke test cannot detect a destroyed model on its own. It exists to
        catch the specific failure where the wrong or damaged graph is deployed,
        which would otherwise present as a healthy service labelling everything
        benign.
        """
        probs, _ = self.predict_probs([SMOKE_TEXT])
        index = self.labels.index(SMOKE_LABEL)
        observed = float(probs[0, index])
        return SmokeResult(
            passed=abs(observed - SMOKE_EXPECTED) <= SMOKE_TOLERANCE,
            label=SMOKE_LABEL,
            observed=observed,
            expected=SMOKE_EXPECTED,
            tolerance=SMOKE_TOLERANCE,
        )

    def warmup(self) -> None:
        """Pay the first-inference cost at startup rather than on a user request."""
        began = time.perf_counter()
        self.predict_probs([SMOKE_TEXT] * min(8, self.max_batch))
        log.info("warmup pass took %.0f ms", (time.perf_counter() - began) * 1000)


__all__ = [
    "InferenceEngine",
    "InferenceError",
    "SMOKE_EXPECTED",
    "SMOKE_LABEL",
    "SMOKE_TEXT",
    "SmokeResult",
]
