"""Request validation, and the normalisation that keeps the model on-distribution.

The DOM reports ``tagName`` in uppercase. Training never saw an uppercase tag, so
normalising at the request boundary is not cosmetic -- it is the difference
between the model seeing a string shape it was trained on and one it was not.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.schemas.classify import MAX_TEXT_CHARS, ClassifyRequest, Snippet


def test_minimal_snippet_uses_training_defaults() -> None:
    snippet = Snippet(text="Only 2 left")
    assert snippet.tag == "span"
    assert snippet.role == "none"
    assert snippet.lang == "en"


def test_dom_uppercase_tag_is_normalised() -> None:
    assert Snippet(text="x", tag="BUTTON").tag == "button"


def test_role_spaces_and_hyphens_fold_to_underscores() -> None:
    assert Snippet(text="x", role="fine print").role == "fine_print"
    assert Snippet(text="x", role="fine-print").role == "fine_print"


def test_blank_tag_falls_back_to_the_default() -> None:
    assert Snippet(text="x", tag="   ").tag == "span"


def test_empty_text_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Snippet(text="")


def test_whitespace_only_text_is_rejected() -> None:
    with pytest.raises(ValidationError, match="non-whitespace"):
        Snippet(text="   \n\t ")


def test_overlong_text_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Snippet(text="a" * (MAX_TEXT_CHARS + 1))


def test_unknown_language_is_rejected() -> None:
    with pytest.raises(ValidationError):
        Snippet(text="x", lang="fr")


def test_unknown_field_is_rejected() -> None:
    """extra='forbid' so a typo'd field is a 422, not a silently ignored value."""
    with pytest.raises(ValidationError):
        Snippet(text="x", tagname="button")


def test_devanagari_text_is_accepted() -> None:
    snippet = Snippet(text="\u0915\u0947\u0935\u0932 3 \u092c\u093e\u0915\u0940", lang="hi")
    assert snippet.lang == "hi"


def test_empty_snippet_list_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ClassifyRequest(snippets=[])


def test_request_defaults() -> None:
    request = ClassifyRequest(snippets=[Snippet(text="x")])
    assert request.profile is None
    assert request.use_cache is True
    assert request.include_all_scores is False


def test_unknown_profile_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ClassifyRequest(snippets=[Snippet(text="x")], profile="aggressive")


def test_ref_is_echoed_through_the_schema() -> None:
    assert Snippet(text="x", ref="node-42").ref == "node-42"
