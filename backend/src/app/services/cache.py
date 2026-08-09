"""Prediction cache.

Stage 2 ships an in-process TTL + LRU cache. Redis is deferred to Stage 2
hardening, per docs/PHASES.md, so the interface below is written so that swapping
in a Redis backend later is a constructor change and nothing else: keys are
already Redis-shaped (``dp:v{model_version}:{sha1}``) and values are already
plain JSON-serialisable dicts.

Why cache at all: a product page re-renders constantly and the extension will
re-submit the same microcopy on every mutation. Cache hits are the difference
between a 30-60 ms forward pass and a <5 ms lookup for 64 keys.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class CacheStats:
    hits: int = 0
    misses: int = 0
    evictions: int = 0
    expirations: int = 0

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0


class PredictionCache:
    """Thread-safe TTL + LRU cache.

    Thread-safe because the ONNX forward pass runs in a worker thread and several
    requests can be in flight at once.
    """

    def __init__(
        self,
        *,
        max_entries: int = 50_000,
        ttl_seconds: int = 604_800,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if max_entries < 1:
            raise ValueError("max_entries must be >= 1")
        if ttl_seconds < 1:
            raise ValueError("ttl_seconds must be >= 1")
        self._max_entries = max_entries
        self._ttl = ttl_seconds
        self._clock = clock
        self._lock = threading.Lock()
        #: key -> (expires_at, value)
        self._store: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
        self.stats = CacheStats()

    def __len__(self) -> int:
        with self._lock:
            return len(self._store)

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self.stats.misses += 1
                return None
            expires_at, value = entry
            if expires_at <= self._clock():
                del self._store[key]
                self.stats.expirations += 1
                self.stats.misses += 1
                return None
            self._store.move_to_end(key)
            self.stats.hits += 1
            return value

    def get_many(self, keys: list[str]) -> dict[str, dict[str, Any]]:
        """Batch lookup. Missing and expired keys are simply absent from the result."""
        found: dict[str, dict[str, Any]] = {}
        for key in keys:
            value = self.get(key)
            if value is not None:
                found[key] = value
        return found

    def set(self, key: str, value: dict[str, Any]) -> None:
        with self._lock:
            self._store[key] = (self._clock() + self._ttl, value)
            self._store.move_to_end(key)
            while len(self._store) > self._max_entries:
                self._store.popitem(last=False)
                self.stats.evictions += 1

    def set_many(self, items: dict[str, dict[str, Any]]) -> None:
        for key, value in items.items():
            self.set(key, value)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()


__all__ = ["CacheStats", "PredictionCache"]
