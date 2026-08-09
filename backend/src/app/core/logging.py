"""Minimal structured-ish logging setup. No dependency beyond stdlib."""

from __future__ import annotations

import logging
import sys

_FORMAT = "%(asctime)s %(levelname)-8s %(name)s | %(message)s"


def configure_logging(level: str = "INFO") -> None:
    """Configure root logging once. Idempotent."""
    root = logging.getLogger()
    if root.handlers:
        root.setLevel(level.upper())
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(handler)
    root.setLevel(level.upper())

    # uvicorn's access log is noisy for a batch endpoint hit on every page load.
    logging.getLogger("uvicorn.access").setLevel("WARNING")
