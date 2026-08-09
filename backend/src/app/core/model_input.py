"""The model input string. Invariant #2.

This MUST stay byte-identical to ``ml/src/ml/config.py::build_model_input``.
If serving builds this string even slightly differently from training, every
prediction degrades silently and no test fails. ``tests/test_model_input.py``
guards it against the real ml/ source when that source is on disk.

Deliberately no normalisation happens here. The training data was generated with
lowercase tags (``p``, ``span``) and lowercase roles (``promo``, ``cta``), so the
DOM's ``tagName`` (``"P"``) has to be lowered *before* it reaches this function.
That normalisation lives in ``normalize_tag`` / ``normalize_role`` and is applied
at the request boundary, so that this function stays a pure mirror of training.
"""

from __future__ import annotations

#: Used when the extension cannot infer a semantic role for a node.
DEFAULT_TAG = "span"
DEFAULT_ROLE = "none"


def build_model_input(text: str, tag: str = DEFAULT_TAG, role: str = DEFAULT_ROLE) -> str:
    """Return the exact string the model was fine-tuned on.

    Mirror of ``ml.config.build_model_input``. Do not "improve" the format.
    """
    return f"[TAG={tag}] [ROLE={role}] {text}"


def normalize_tag(tag: str | None) -> str:
    """Lowercase and trim an HTML tag name, falling back to the training default.

    The DOM reports ``tagName`` in uppercase. Training never saw an uppercase
    tag, so passing one through would put the model off-distribution.
    """
    if tag is None:
        return DEFAULT_TAG
    cleaned = tag.strip().lower()
    return cleaned or DEFAULT_TAG


def normalize_role(role: str | None) -> str:
    """Lowercase and trim a semantic role, falling back to the training default.

    Roles in the dataset are single lowercase tokens with underscores
    (``fine_print``, ``form_gate``). Spaces and hyphens are folded to underscores
    so that an extension sending ``"fine print"`` still lands on a seen role.
    """
    if role is None:
        return DEFAULT_ROLE
    cleaned = role.strip().lower().replace("-", "_").replace(" ", "_")
    return cleaned or DEFAULT_ROLE
