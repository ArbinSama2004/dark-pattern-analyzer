"""Invariant #2: build_model_input must stay byte-identical to ml/.

This is the drift guard the backend README promises. It does not import from ml/
-- the backend must never depend on that package -- it loads
``ml/src/ml/config.py`` from disk as an isolated module and compares outputs
string by string. If someone "improves" either copy, this fails.

Why it matters: training consumed ``[TAG=button] [ROLE=decline] No thanks``. If
serving builds ``[TAG=button][ROLE=decline] No thanks`` instead, the model is off
distribution, accuracy drops quietly, and nothing else in the suite notices.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from app.core.model_input import build_model_input, normalize_role, normalize_tag

# Cases chosen to cover the format's fragile parts: spacing, empty text, unicode,
# and text that itself contains bracket syntax.
CASES = [
    ("Only 2 left in stock!", "span", "none"),
    ("No thanks, I like paying full price", "button", "decline"),
    ("\u0915\u0947\u0935\u0932 3 \u092c\u093e\u0915\u0940", "p", "stock"),
    ("\u0915\u0947\u0935\u0932 \u0967\u0968 \u0918\u0928\u094d\u091f\u093e", "div", "timer"),
    ("[TAG=fake] injected", "li", "fine_print"),
    ("  leading and trailing  ", "h2", "heading"),
    ("tab\tinside", "label", "checkbox"),
]


def _load_ml_config(path: Path):
    """Load ml/src/ml/config.py as a standalone module without importing ml/."""
    spec = importlib.util.spec_from_file_location("_ml_config_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_format_is_exactly_as_documented() -> None:
    assert build_model_input("hello", "span", "none") == "[TAG=span] [ROLE=none] hello"


def test_defaults_match_training_defaults() -> None:
    assert build_model_input("hello") == "[TAG=span] [ROLE=none] hello"


@pytest.mark.parametrize(("text", "tag", "role"), CASES)
def test_byte_identical_to_ml_source(text: str, tag: str, role: str, ml_config_path: Path) -> None:
    ml_config = _load_ml_config(ml_config_path)
    expected = ml_config.build_model_input(text, tag, role)
    actual = build_model_input(text, tag, role)
    assert actual == expected, (
        "build_model_input drifted from ml/src/ml/config.py.\n"
        f"  ml/:      {expected!r}\n"
        f"  backend/: {actual!r}"
    )
    assert actual.encode("utf-8") == expected.encode("utf-8")


def test_ml_and_backend_agree_on_defaults(ml_config_path: Path) -> None:
    ml_config = _load_ml_config(ml_config_path)
    assert build_model_input("x") == ml_config.build_model_input("x")


def test_no_normalisation_inside_build_model_input() -> None:
    """build_model_input is a pure mirror of training; it must not fix up inputs.

    Normalisation happens at the request boundary. If it crept in here, the two
    copies would diverge and the test above would be the only thing standing
    between that and silent accuracy loss.
    """
    assert build_model_input("t", "BUTTON", "Decline") == "[TAG=BUTTON] [ROLE=Decline] t"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("P", "p"), ("BUTTON", "button"), ("  Span ", "span"), ("", "span"), (None, "span")],
)
def test_normalize_tag(raw: str | None, expected: str) -> None:
    assert normalize_tag(raw) == expected


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("CTA", "cta"),
        ("fine print", "fine_print"),
        ("fine-print", "fine_print"),
        ("  Form_Gate ", "form_gate"),
        ("", "none"),
        (None, "none"),
    ],
)
def test_normalize_role(raw: str | None, expected: str) -> None:
    assert normalize_role(raw) == expected
