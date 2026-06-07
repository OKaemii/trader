"""Tests for the in-process TTL+LRU fronting the factor_scores reads (T10).

Covers the cache contract the scores endpoint relies on: hit (no re-compute), TTL expiry
(re-compute after the window), LRU eviction (oldest dropped past maxsize), herd coalescing
(concurrent cold-key callers compute once), and the asOf-bucketing key that lets nearby
point-in-time reads share an entry while the "latest" (None asOf) read stays its own bucket.

Pure + deps-light: a monkeypatched monotonic clock drives TTL deterministically (no sleeps), and
the "compute" is a counting coroutine — no Mongo, no numpy.
"""
from __future__ import annotations

import asyncio

import pytest

from src.infrastructure.lru_cache import (
    ALL_UNIVERSE,
    BUCKET_MS,
    TTLCache,
    bucket_asof,
    scores_cache_key,
)


def _clock():
    """A controllable monotonic clock: returns the current value; bump it via the returned setter."""
    state = {"t": 1000.0}

    def now():
        return state["t"]

    def advance(dt):
        state["t"] += dt

    return now, advance


@pytest.mark.asyncio
async def test_hit_does_not_recompute():
    """A second get for a live key returns the cached value without calling compute again."""
    cache = TTLCache(maxsize=8, ttl_s=10.0)
    calls = {"n": 0}

    async def compute():
        calls["n"] += 1
        return f"v{calls['n']}"

    assert await cache.get_or_compute("k", compute) == "v1"
    assert await cache.get_or_compute("k", compute) == "v1"   # served from cache
    assert calls["n"] == 1
    assert cache.stats()["hits"] == 1 and cache.stats()["misses"] == 1


@pytest.mark.asyncio
async def test_expired_entry_recomputes(monkeypatch):
    """Past the TTL the entry is stale → compute runs again and the fresh value is returned."""
    cache = TTLCache(maxsize=8, ttl_s=10.0)
    now, advance = _clock()
    monkeypatch.setattr(cache, "_now", now)
    calls = {"n": 0}

    async def compute():
        calls["n"] += 1
        return calls["n"]

    assert await cache.get_or_compute("k", compute) == 1
    advance(9.0)                                              # still within TTL
    assert await cache.get_or_compute("k", compute) == 1
    advance(2.0)                                              # now 11s > 10s TTL → expired
    assert await cache.get_or_compute("k", compute) == 2
    assert calls["n"] == 2


@pytest.mark.asyncio
async def test_lru_evicts_least_recently_used():
    """Past maxsize the least-recently-used entry is dropped, and a touch promotes an entry so it
    survives the next eviction. maxsize=2: a,b in; touch a; insert c evicts b (the LRU)."""
    counts = {"a": 0, "b": 0, "c": 0}

    def maker(name):
        async def compute():
            counts[name] += 1
            return name
        return compute

    cache = TTLCache(maxsize=2, ttl_s=100.0)
    await cache.get_or_compute("a", maker("a"))   # {a}
    await cache.get_or_compute("b", maker("b"))   # {a, b}
    await cache.get_or_compute("a", maker("a"))   # hit (touch a) → LRU order: b, a
    await cache.get_or_compute("c", maker("c"))   # insert c → evict b (the LRU)
    assert counts == {"a": 1, "b": 1, "c": 1}     # each computed once so far

    # 'a' + 'c' survive (cache hits → no recompute); 'b' was evicted (miss → recompute).
    assert await cache.get_or_compute("a", maker("a")) == "a"
    assert await cache.get_or_compute("c", maker("c")) == "c"
    assert counts["a"] == 1 and counts["c"] == 1   # both still cached
    await cache.get_or_compute("b", maker("b"))     # 'b' was evicted → recompute
    assert counts["b"] == 2


@pytest.mark.asyncio
async def test_concurrent_cold_key_coalesces_to_one_compute():
    """Concurrent callers for the same cold key compute ONCE (a thundering-herd guard) — the lock
    serialises the get-or-compute so the second caller sees the just-stored value."""
    cache = TTLCache(maxsize=8, ttl_s=10.0)
    calls = {"n": 0}

    async def slow_compute():
        calls["n"] += 1
        await asyncio.sleep(0.01)   # widen the race window
        return "value"

    results = await asyncio.gather(*[cache.get_or_compute("hot", slow_compute) for _ in range(5)])
    assert results == ["value"] * 5
    assert calls["n"] == 1   # coalesced — one upstream read, not five


def test_bucket_asof_floors_to_bucket_and_keeps_none():
    """asOf bucketing floors to BUCKET_MS so nearby instants share a key; None (latest) stays None
    so a latest read never collides with a point-in-time read."""
    base = 5 * BUCKET_MS
    assert bucket_asof(base) == base
    assert bucket_asof(base + 1) == base               # same bucket as base
    assert bucket_asof(base + BUCKET_MS) == base + BUCKET_MS   # next bucket
    assert bucket_asof(None) is None                   # latest read is its own bucket


@pytest.mark.asyncio
async def test_latest_and_asof_keys_do_not_collide():
    """A (ticker, None) latest read and a (ticker, bucket) as-of read are distinct cache entries —
    so an as-of read never serves a today's-latest value (the WhyPanel honesty contract)."""
    cache = TTLCache(maxsize=8, ttl_s=100.0)

    async def latest():
        return "latest"

    async def asof():
        return "asof"

    k_latest = ("AAPL_US_EQ", bucket_asof(None))
    k_asof = ("AAPL_US_EQ", bucket_asof(1_700_000_000_000))
    assert k_latest != k_asof
    assert await cache.get_or_compute(k_latest, latest) == "latest"
    assert await cache.get_or_compute(k_asof, asof) == "asof"


def test_all_universe_sentinel_is_not_a_real_ticker():
    """The all-universe sentinel can't collide with a real T212 ticker (the latest_all key)."""
    assert ALL_UNIVERSE not in ("AAPL_US_EQ", "VODl_EQ", "")
    assert "_EQ" not in ALL_UNIVERSE


def test_scores_cache_key_maps_the_three_read_shapes():
    """The three scores read shapes map to three distinct keys: all-universe latest (empty ticker →
    sentinel, None bucket), per-ticker latest (ticker, None bucket), and per-ticker as-of (ticker,
    floored bucket)."""
    assert scores_cache_key("", None) == (ALL_UNIVERSE, None)              # latest_all
    assert scores_cache_key("AAPL_US_EQ", None) == ("AAPL_US_EQ", None)    # latest_for
    asof = 7 * BUCKET_MS + 123
    assert scores_cache_key("AAPL_US_EQ", asof) == ("AAPL_US_EQ", 7 * BUCKET_MS)   # as_of, bucketed
    # The three keys are mutually distinct (no cross-shape collision).
    keys = {scores_cache_key("", None), scores_cache_key("AAPL_US_EQ", None), scores_cache_key("AAPL_US_EQ", asof)}
    assert len(keys) == 3
