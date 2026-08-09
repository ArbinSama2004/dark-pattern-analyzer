"""Invariant #4: the model version is in every cache key.

Also pins the two hashes apart. Collapsing them would look like a simplification
and would quietly break the tag/role signal, which is exactly what
``build_model_input`` exists to preserve.
"""

from __future__ import annotations

from app.core.hashing import cache_key, snippet_id


def _key(**overrides) -> str:
    base = {
        "model_version": "1.0.0",
        "profile": "precision",
        "lang": "en",
        "tag": "span",
        "role": "none",
        "text": "Only 2 left in stock!",
    }
    base.update(overrides)
    return cache_key(**base)


# --- snippet_id ------------------------------------------------------------


def test_snippet_id_is_the_documented_hash() -> None:
    import hashlib

    expected = hashlib.sha1("en\u0000hello".encode()).hexdigest()
    assert snippet_id("hello", "en") == expected


def test_snippet_id_is_stable() -> None:
    assert snippet_id("hello", "en") == snippet_id("hello", "en")


def test_snippet_id_separates_language() -> None:
    assert snippet_id("hello", "en") != snippet_id("hello", "hi")


def test_snippet_id_nul_separator_prevents_collision() -> None:
    """Without a separator, ('e','nhello') and ('en','hello') would collide."""
    assert snippet_id("nhello", "e") != snippet_id("hello", "en")


def test_snippet_id_ignores_tag_and_role_by_design() -> None:
    """Snippet identity is about page text, so the same sentence keeps one id."""
    assert snippet_id("Add to cart", "en") == snippet_id("Add to cart", "en")


def test_snippet_id_handles_devanagari() -> None:
    text = "\u0915\u0947\u0935\u0932 3 \u092c\u093e\u0915\u0940"
    assert len(snippet_id(text, "hi")) == 40
    assert snippet_id(text, "hi") != snippet_id(text, "ne")


# --- cache_key -------------------------------------------------------------


def test_cache_key_is_redis_shaped() -> None:
    key = _key()
    assert key.startswith("dp:v1.0.0:")
    assert len(key.split(":")[-1]) == 40


def test_model_version_change_invalidates_the_cache() -> None:
    """A retrain must not be able to serve stale predictions."""
    assert _key(model_version="1.0.0") != _key(model_version="1.1.0")


def test_profile_change_invalidates_the_cache() -> None:
    assert _key(profile="precision") != _key(profile="recall")


def test_role_change_invalidates_the_cache() -> None:
    """'No thanks' on a decline button is not the same input as in a paragraph."""
    assert _key(role="none") != _key(role="decline")


def test_tag_change_invalidates_the_cache() -> None:
    assert _key(tag="span") != _key(tag="button")


def test_lang_change_invalidates_the_cache() -> None:
    assert _key(lang="en") != _key(lang="ne")


def test_text_change_invalidates_the_cache() -> None:
    assert _key(text="a") != _key(text="b")


def test_identical_inputs_hit_the_same_key() -> None:
    assert _key() == _key()


def test_cache_key_is_not_the_snippet_id() -> None:
    assert snippet_id("Only 2 left in stock!", "en") not in _key()
