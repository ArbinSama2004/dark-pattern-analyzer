"""Measure real inference latency against the artifact bundle.

    cd backend && uv run python scripts/bench_latency.py
    make bench

Fills in docs/RESULTS.md section 5, which was written as an empty table under an
int8 assumption that did not survive parity testing (see RESULTS.md section 4).
The point of this script is to replace that estimate with a measurement on the
hardware actually being used, and to say plainly whether the original 100 ms
budget is achievable.

What is measured, and what is not:

* **Measured here:** tokenisation + ONNX forward pass + post-processing, i.e.
  everything `/v1/classify` does per batch after the request body is parsed.
  This is the part that dominates and the part the budget was written about.
* **Not measured here:** in-page extraction and rule evaluation (they run in the
  browser, not this process) and network round trip (localhost is not a
  meaningful measurement of anything). Those rows stay empty in RESULTS.md
  rather than being filled with numbers from the wrong machine.

Percentiles are reported rather than a mean. A mean hides exactly the tail that
makes a UI feel slow, and p95 is what the budget was expressed in.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from app.core.bundle import BundleError, load_bundle  # noqa: E402
from app.core.model_input import build_model_input  # noqa: E402
from app.services.cache import PredictionCache  # noqa: E402
from app.services.inference import InferenceEngine  # noqa: E402
from app.settings import get_settings  # noqa: E402

#: Deliberately realistic rather than uniform: a real page mixes short button
#: labels with longer fine print, and padding to the longest item in the batch
#: is what actually costs time. A batch of 32 identical short strings would
#: report a number the real pipeline never achieves.
SAMPLE_TEXTS = [
    "Add to cart",
    "Only 2 left in stock!",
    "No thanks, I don't like saving money",
    "Offer ends in 09:58",
    "37 people are viewing this right now",
    "Create an account to view prices",
    "Free delivery on orders over Rs. 1,000",
    "By continuing you agree to our terms and conditions and privacy policy",
    "Cancel your subscription by calling us during office hours",
    "Rs. 1,499",
    "-50%",
    "958 sold",
    "सीमित समयको लागि मात्र",
    "केवल २ बाँकी छ",
    "अभी खरीदें और बचाएं",
    "यह ऑफर जल्द समाप्त हो रहा है",
]


def make_batch(size: int) -> list[str]:
    """A batch of `size` model-input strings, cycling the sample texts."""
    return [
        build_model_input(
            text=SAMPLE_TEXTS[i % len(SAMPLE_TEXTS)],
            tag="span",
            role="none",
        )
        for i in range(size)
    ]


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile. No interpolation: with 50-ish samples,
    interpolating invents precision the sample size does not support."""
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(p / 100.0 * len(ordered) + 0.5)) - 1))
    return ordered[index]


def bench_inference(engine: InferenceEngine, batch_size: int, runs: int) -> list[float]:
    batch = make_batch(batch_size)
    timings: list[float] = []
    for _ in range(runs):
        started = time.perf_counter()
        engine.predict_probs(batch)
        timings.append((time.perf_counter() - started) * 1000.0)
    return timings


def bench_cache(batch_size: int, runs: int) -> list[float]:
    """The cache-hit path: what a repeated page costs when nothing is inferred."""
    cache = PredictionCache(max_entries=10_000, ttl_seconds=600)
    keys = [f"dp:v1.0.0:key{i}" for i in range(batch_size)]
    for key in keys:
        cache.set(key, {"findings": [], "benign": True})

    timings: list[float] = []
    for _ in range(runs):
        started = time.perf_counter()
        cache.get_many(keys)
        timings.append((time.perf_counter() - started) * 1000.0)
    return timings


def report(name: str, timings: list[float], budget_ms: float | None = None) -> None:
    p50, p95 = percentile(timings, 50), percentile(timings, 95)
    line = (
        f"{name:<34}{p50:>9.1f}{p95:>9.1f}"
        f"{min(timings):>9.1f}{max(timings):>9.1f}"
    )
    if budget_ms is not None:
        line += f"   budget {budget_ms:.0f} ms" + ("  OVER" if p95 > budget_ms else "  ok")
    print(line)


def main() -> int:
    ap = argparse.ArgumentParser(description="Measure inference latency")
    ap.add_argument("--runs", type=int, default=50, help="Timed runs per case (default 50)")
    ap.add_argument("--warmup", type=int, default=5, help="Untimed warmup runs (default 5)")
    args = ap.parse_args()

    settings = get_settings()
    try:
        bundle = load_bundle(
            settings.model_dir,
            profile=settings.threshold_profile,
            expected_version=settings.model_version,
        )
    except BundleError as exc:
        print(f"Cannot load the bundle: {exc}", file=sys.stderr)
        return 1

    engine = InferenceEngine(
        bundle,
        max_batch=settings.max_batch,
        intra_op_threads=settings.onnx_intra_op_threads,
    )

    print(f"bundle:      {bundle.describe()}")
    print(f"runs:        {args.runs} timed, {args.warmup} warmup")
    print()

    # Warmup is not optional and is not cheating: the first forward pass pays
    # for graph optimisation, and the service does exactly this at startup so
    # no user request ever pays it. Timing it here would measure something
    # production never experiences.
    for _ in range(args.warmup):
        engine.predict_probs(make_batch(32))

    print(f"{'case':<34}{'p50':>9}{'p95':>9}{'min':>9}{'max':>9}")
    print("-" * 78)

    for size in (1, 8, 32, 64):
        timings = bench_inference(engine, size, args.runs)
        budget = 40.0 if size == 32 else None
        report(f"inference, batch of {size}", timings, budget)

    report("cache hit, 32 keys", bench_cache(32, args.runs), 15.0)

    print()
    print("Extraction and rules run in the browser and are not measured here.")
    print("Network round trip on localhost is not a meaningful figure and is omitted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
