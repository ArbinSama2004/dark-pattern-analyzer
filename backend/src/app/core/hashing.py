"""Stable identifiers. Invariant #4: the model version is in every cache key.

Two different hashes live here on purpose:

``snippet_id``
    Identity of a piece of *page text*, per the Stage 2 contract:
    ``sha1(lang + "\\u0000" + text)``. It is what the extension and (in Stage 4)
    the findings table use to refer to a snippet. It deliberately ignores tag and
    role, so the same sentence keeps one id wherever it appears on the page.

``cache_key``
    Identity of a *prediction*. It must additionally cover everything that can
    change the output: model version, threshold profile, tag and role. Reusing
    ``snippet_id`` for the cache would serve a paragraph's prediction for the same
    words on a cancel button, which is exactly the signal the model relies on.
"""

from __future__ import annotations

import hashlib

#: Field separator that cannot occur in DOM text.
_SEP = "\u0000"


def snippet_id(text: str, lang: str) -> str:
    """Return the snippet identity hash: ``sha1(lang + NUL + text)``."""
    payload = f"{lang}{_SEP}{text}".encode()
    return hashlib.sha1(payload).hexdigest()  # noqa: S324 - identity, not security


def cache_key(
    *,
    model_version: str,
    profile: str,
    lang: str,
    tag: str,
    role: str,
    text: str,
) -> str:
    """Return the Redis-compatible cache key ``dp:v{model_version}:{hash}``.

    The digest covers every input that can change the prediction. A retrain that
    bumps ``model_version`` therefore invalidates the entire cache with no flush,
    which is the whole point of invariant #4.
    """
    payload = _SEP.join((model_version, profile, lang, tag, role, text)).encode()
    digest = hashlib.sha1(payload).hexdigest()  # noqa: S324 - identity, not security
    return f"dp:v{model_version}:{digest}"
