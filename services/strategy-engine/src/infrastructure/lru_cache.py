"""A tiny in-process TTL + LRU cache fronting the factor_scores reads (T10).

The ``GET /admin/api/strategy/scores`` endpoint is read by every Research surface (Overview factor
bars, entity-search enrichment, the signal "Why?" panel) and the same ``(ticker, asOf)`` is hit
repeatedly within a render. factor_scores rows only change once per (daily) cycle, so a short-TTL
cache in front of Mongo collapses that fan-in to one read per cycle-ish without ever serving a stale
*cross-cycle* value (the TTL is far shorter than the cycle cadence).

Design:
- **Key** = ``(ticker, asOf-bucket)``. ``ticker`` is the queried symbol (a sentinel for the
  all-universe ``latest_all`` read); the asOf-bucket is the point-in-time knowledge cutoff floored
  to ``BUCKET_MS`` so callers asking for nearby asOf instants (e.g. a signal timestamp re-read on
  each poll) share one entry, exactly like shared-bars' 60s asOf bucketing. ``None`` asOf (the
  "latest" read) is its own bucket — it must NOT collide with a point-in-time read.
- **TTL** evicts an entry ``ttl_s`` after it was written (cycle-fresh, never cross-cycle stale).
- **LRU** caps the entry count so a wide universe of one-off ticker reads can't grow unbounded;
  the least-recently-used entry is dropped past ``maxsize``.

Async-safe for the single-process FastAPI host: every public method holds an ``asyncio.Lock`` for
the whole get-or-compute, so concurrent requests for the same cold key coalesce onto ONE upstream
read (a thundering-herd guard) rather than each firing its own Mongo query.

This is a cache, never a source of truth: an empty/None upstream result is cached the same as a hit
(so a pre-backfill empty store doesn't re-hit Mongo every request), and the host degrades an empty
store to ``{}`` at the endpoint layer — the cache is transparent to that contract.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from typing import Awaitable, Callable, Hashable, Optional, TypeVar

V = TypeVar("V")

# asOf-bucket width. 60s mirrors shared-bars' as-of bucketing: nearby point-in-time reads (a signal
# timestamp re-read on each 15s poll) collapse to one entry without crossing a cycle boundary.
BUCKET_MS = 60_000

# The sentinel ticker for the all-universe latest_all read (no per-ticker key). Chosen to never
# collide with a real T212 ticker (which are like ``AAPL_US_EQ`` / ``VODl_EQ``).
ALL_UNIVERSE = "*all*"


def bucket_asof(as_of_ms: Optional[int]) -> Optional[int]:
    """Floor a knowledge-time cutoff to ``BUCKET_MS`` so nearby asOf reads share a cache entry.
    ``None`` (the "latest" read) stays ``None`` — its own bucket, distinct from any point-in-time
    bucket, so a latest read and an as-of read for the same ticker never collide."""
    if as_of_ms is None:
        return None
    return (as_of_ms // BUCKET_MS) * BUCKET_MS


def scores_cache_key(ticker: str, as_of_ms: Optional[int]) -> tuple[str, Optional[int]]:
    """The (ticker, asOf-bucket) key the scores endpoint caches on. An empty ticker (the
    all-universe ``latest_all`` read) maps to the ``ALL_UNIVERSE`` sentinel so it can't collide
    with a real symbol; the asOf is bucketed (``None`` → the distinct "latest" bucket)."""
    return (ticker or ALL_UNIVERSE, bucket_asof(as_of_ms))


class TTLCache:
    """In-process async TTL + LRU cache. One instance per host process; not multi-pod coherent by
    design (the TTL is the cross-pod consistency bound — every pod re-reads within ``ttl_s``)."""

    def __init__(self, *, maxsize: int = 512, ttl_s: float = 10.0) -> None:
        self._maxsize = maxsize
        self._ttl_s = ttl_s
        # key → (expires_monotonic, value). OrderedDict gives O(1) LRU via move_to_end/popitem.
        self._store: "OrderedDict[Hashable, tuple[float, object]]" = OrderedDict()
        self._lock = asyncio.Lock()
        self._hits = 0
        self._misses = 0

    def _now(self) -> float:
        # Monotonic clock — immune to wall-clock jumps (NTP steps), correct for TTL deltas.
        return time.monotonic()

    async def get_or_compute(self, key: Hashable, compute: Callable[[], Awaitable[V]]) -> V:
        """Return the cached value for ``key`` if present and unexpired, else ``await compute()``,
        store it, and return it. The whole operation holds the lock so concurrent callers for the
        same cold key compute ONCE (coalesced) rather than racing the upstream read."""
        async with self._lock:
            now = self._now()
            entry = self._store.get(key)
            if entry is not None and entry[0] > now:
                self._hits += 1
                self._store.move_to_end(key)   # mark most-recently-used
                return entry[1]  # type: ignore[return-value]
            # Miss or expired — compute under the lock (coalesces a herd onto one read).
            self._misses += 1
            value = await compute()
            self._store[key] = (now + self._ttl_s, value)
            self._store.move_to_end(key)
            while len(self._store) > self._maxsize:
                self._store.popitem(last=False)   # evict least-recently-used
            return value

    def stats(self) -> dict[str, int]:
        """Hit/miss/size counters — surfaced for diagnostics, not on the read path."""
        return {"hits": self._hits, "misses": self._misses, "size": len(self._store)}

    def clear(self) -> None:
        """Drop every entry (test hook + a manual-invalidation seam)."""
        self._store.clear()
