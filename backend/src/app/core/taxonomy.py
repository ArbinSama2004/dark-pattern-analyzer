"""Label order and taxonomy metadata. Invariant #1.

The label order is FROZEN. It is baked into the ONNX output axis, into
``thresholds.json`` and into every cache key. Reordering it silently remaps every
prediction: scarcity becomes sneaking and nothing crashes.

At serving time the order is read from the bundle's ``label_map.json``, not from
this file. The constant below exists only so the loader can *verify* the bundle
and refuse to start on drift.
"""

from __future__ import annotations

#: The expected label order, mirroring ``ml.config.LABELS``.
EXPECTED_LABELS: tuple[str, ...] = (
    "confirmshaming",
    "false_urgency",
    "forced_action",
    "obstruction",
    "scarcity",
    "sneaking",
    "social_proof",
    "benign",
)

#: The negative class. Excluded from "findings": reporting benign as a detection
#: would be nonsense, and it is excluded from macro-F1 upstream for the same
#: reason (largest and easiest class, inflates the headline).
BENIGN_LABEL = "benign"

#: The seven manipulative classes, in frozen order.
DARK_LABELS: tuple[str, ...] = tuple(lab for lab in EXPECTED_LABELS if lab != BENIGN_LABEL)

#: Short user-facing descriptions. The extension renders these; the wording is
#: deliberately hedged. Never "illegal", "violation" or "fraud" -- this tool
#: flags *potentially manipulative patterns*, it does not render legal verdicts.
LABEL_DESCRIPTIONS: dict[str, str] = {
    "confirmshaming": "Wording that shames or guilts you for declining.",
    "false_urgency": "A deadline or countdown that may be fabricated or resetting.",
    "forced_action": "Requires an unrelated action to proceed, such as signing up.",
    "obstruction": "Makes an action harder than it needs to be, such as cancelling.",
    "scarcity": "Claims limited stock or availability that may be unverifiable.",
    "sneaking": "Slips in a charge, opt-in or condition you did not choose.",
    "social_proof": "Unverifiable real-time activity used as peer pressure.",
    "benign": "No manipulative pattern detected.",
}

LANGS: tuple[str, ...] = ("en", "hi", "ne")


class LabelContractError(RuntimeError):
    """Raised when the artifact bundle's label order does not match expectations."""


def verify_label_order(labels: list[str]) -> None:
    """Fail loudly if the bundle's label order drifted from the frozen contract.

    Startup must abort here. A running service with a permuted label axis is
    worse than a service that will not boot, because it looks healthy.
    """
    if tuple(labels) != EXPECTED_LABELS:
        raise LabelContractError(
            "label order drift: bundle label_map.json does not match the frozen contract.\n"
            f"  expected: {list(EXPECTED_LABELS)}\n"
            f"  bundle:   {labels}\n"
            "Refusing to start. Re-export the bundle or fix label_map.json."
        )
