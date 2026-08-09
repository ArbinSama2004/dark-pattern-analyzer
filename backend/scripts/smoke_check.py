"""Standalone bundle smoke check. Run this before trusting a deployment.

    cd backend && uv run python scripts/smoke_check.py

What it does, in order:

1. Loads and verifies the bundle (label order, model version, thresholds).
2. Creates the ONNX session and the tokenizer.
3. Runs Stage 1's reference input and compares against the known value
   (scarcity = 0.626 for ``[TAG=span] [ROLE=none] Only 2 left in stock!``).
4. Runs a handful of hand-written snippets in all three languages and prints the
   findings, so an operator can eyeball that predictions are sane.

This is NOT a replacement for ``make parity``. The notebook is explicit that a
smoke test alone cannot detect a destroyed model -- int8 collapsed all seven dark
classes to zero positives while the smoke test still printed plausible numbers.
The reference value in step 3 is what makes this useful anyway: a collapsed graph
misses 0.626 by roughly 0.3.
"""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from app.core.bundle import BundleError, load_bundle  # noqa: E402
from app.core.model_input import build_model_input  # noqa: E402
from app.services.inference import InferenceEngine  # noqa: E402
from app.services.postprocess import decide  # noqa: E402
from app.settings import get_settings  # noqa: E402

#: (text, tag, role, lang). Deliberately includes benign near-misses -- the whole
#: point of dataset v2.1 was that a static verifiable aggregate is benign while
#: unverifiable real-time activity is not.
SAMPLES = [
    ("Only 2 left in stock!", "span", "stock", "en"),
    ("Offer ends in 09:58", "div", "timer", "en"),
    ("No thanks, I like paying full price", "button", "decline", "en"),
    ("12 people are viewing this right now", "span", "promo", "en"),
    ("Rated 4.6 out of 5 by 12,480 verified buyers", "p", "badge", "en"),
    ("Free returns within 30 days", "p", "help_text", "en"),
    ("\u0915\u0947\u0935\u0932 3 \u092c\u093e\u0915\u0940 \u0939\u0948\u0902", "span", "stock", "hi"),
    ("\u0905\u092c \u0916\u0930\u093f\u0926 \u0928\u0917\u0930\u0947 \u092e\u094c\u0915\u093e \u0917\u0941\u092e\u094d\u0928\u0947\u0925\u093f\u092f\u094b", "div", "promo", "ne"),
]


def main() -> int:
    settings = get_settings()
    print(f"bundle : {settings.model_dir}")
    print(f"profile: {settings.threshold_profile}")

    try:
        bundle = load_bundle(
            settings.model_dir,
            profile=settings.threshold_profile,
            expected_version=settings.model_version,
        )
    except BundleError as exc:
        print(f"\nFAILED to load bundle:\n{exc}")
        return 2

    for key, value in bundle.describe().items():
        print(f"  {key:<18} {value}")

    engine = InferenceEngine(bundle, max_batch=settings.max_batch)

    smoke = engine.smoke_check()
    print(f"\n{smoke.message()}")
    if not smoke.passed:
        print(
            "\nThe reference input did not reproduce. This is the signature of a\n"
            "damaged or mismatched graph: an int8 collapse, or a pointer file whose\n"
            "weights live in an external .data sidecar. Re-export fp32 and re-run\n"
            "`make parity` before deploying."
        )
        return 1

    texts = [build_model_input(text, tag, role) for text, tag, role, _ in SAMPLES]
    probs, elapsed_ms = engine.predict_probs(texts)
    decisions = decide(probs, labels=bundle.labels, thresholds=bundle.threshold_vector())

    print(f"\n{len(SAMPLES)} samples in {elapsed_ms:.0f} ms "
          f"({elapsed_ms / len(SAMPLES):.1f} ms/snippet)\n")
    for (text, _tag, role, lang), decision in zip(SAMPLES, decisions, strict=True):
        preview = text if len(text) <= 46 else text[:43] + "..."
        if decision["findings"]:
            summary = ", ".join(
                f"{f['label']} {f['score']:.3f}" for f in decision["findings"]
            )
        else:
            summary = f"benign (benign score {decision['benign_score']:.3f})"
        print(f"  [{lang}] {preview:<46} role={role:<10} -> {summary}")

    print("\nReminder: these are heuristic signals for human review, not legal findings.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
