"""Cache behaviour: TTL, LRU eviction, thread safety.

The clock is injected so TTL is tested deterministically rather than with sleeps.
"""

from __future__ import annotations

import threading

from app.services.cache import PredictionCache


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_set_then_get() -> None:
    cache = PredictionCache()
    cache.set("k", {"benign": True})
    assert cache.get("k") == {"benign": True}
    assert cache.stats.hits == 1


def test_miss_is_counted() -> None:
    cache = PredictionCache()
    assert cache.get("absent") is None
    assert cache.stats.misses == 1
    assert cache.stats.hit_rate == 0.0


def test_entry_expires_after_ttl() -> None:
    clock = FakeClock()
    cache = PredictionCache(ttl_seconds=10, clock=clock)
    cache.set("k", {"v": 1})
    clock.advance(9)
    assert cache.get("k") == {"v": 1}
    clock.advance(2)
    assert cache.get("k") is None
    assert cache.stats.expirations == 1


def test_expired_entry_is_removed_not_just_hidden() -> None:
    clock = FakeClock()
    cache = PredictionCache(ttl_seconds=5, clock=clock)
    cache.set("k", {"v": 1})
    clock.advance(6)
    cache.get("k")
    assert len(cache) == 0


def test_lru_evicts_the_least_recently_used() -> None:
    cache = PredictionCache(max_entries=2)
    cache.set("a", {"v": 1})
    cache.set("b", {"v": 2})
    cache.get("a")  # 'a' becomes most recent, so 'b' is next out
    cache.set("c", {"v": 3})
    assert cache.get("b") is None
    assert cache.get("a") == {"v": 1}
    assert cache.get("c") == {"v": 3}
    assert cache.stats.evictions == 1


def test_max_entries_is_respected() -> None:
    cache = PredictionCache(max_entries=10)
    for i in range(100):
        cache.set(f"k{i}", {"v": i})
    assert len(cache) == 10


def test_get_many_returns_only_present_keys() -> None:
    cache = PredictionCache()
    cache.set("a", {"v": 1})
    found = cache.get_many(["a", "b"])
    assert found == {"a": {"v": 1}}


def test_set_many_and_clear() -> None:
    cache = PredictionCache()
    cache.set_many({"a": {"v": 1}, "b": {"v": 2}})
    assert len(cache) == 2
    cache.clear()
    assert len(cache) == 0


def test_overwrite_refreshes_ttl() -> None:
    clock = FakeClock()
    cache = PredictionCache(ttl_seconds=10, clock=clock)
    cache.set("k", {"v": 1})
    clock.advance(8)
    cache.set("k", {"v": 2})
    clock.advance(5)
    assert cache.get("k") == {"v": 2}


def test_concurrent_access_does_not_corrupt() -> None:
    """The ONNX pass runs in a worker thread, so several requests race here."""
    cache = PredictionCache(max_entries=500)

    def worker(offset: int) -> None:
        for i in range(200):
            key = f"k{(offset + i) % 300}"
            cache.set(key, {"v": i})
            cache.get(key)

    threads = [threading.Thread(target=worker, args=(n * 50,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(cache) <= 500
