"""Async sliding-window rate limiter for the external identity sources (EDGAR, OpenFIGI).

A Python mirror of `EodhdCreditLimiter`
(services/market-data-service/.../providers/eodhd-credit-limiter.ts): a per-window request
budget that serialises concurrent callers so the counter mutates atomically between awaits.

Why it exists here and not only in the downloader (epic Task 5): the security-master clients are
the *first* code in this service that touches an external HTTP source, and both sources publish hard
courtesy limits that a backfill loop will trip without throttling —
  - SEC EDGAR: 10 requests/second, enforced per source IP with a mandatory descriptive
    `User-Agent`; exceeding it earns a 403/429 and, repeated, an IP block.
  - OpenFIGI: ~25 requests/minute unauthenticated (≈250/min with an API key); a 429 carries a
    `Retry-After`.
Both are slow, bounded windows, so one small limiter shaped like the EODHD one covers them by
construction (`RateLimiter(max_calls, per_seconds)`).

`acquire()` is a coroutine that returns only once a slot is free, sleeping just past the oldest
in-window call's expiry when the window is full — it never raises, so an ingest loop degrades to
"goes slower", never "throws mid-batch" (the EODHD limiter's per-day *cap* throws; these sources
have no day cap, only a rate, so there is nothing to fail closed on — back-pressure is the whole
contract). A single oversized burst is admitted when the window is empty so it can never deadlock.

The clock is injected (`now`/`sleep`) purely so the unit tests can drive virtual time without real
sleeps; production uses the monotonic-clock defaults.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Awaitable, Callable


class RateLimiter:
    """Token-free sliding-window limiter: at most `max_calls` `acquire()`s succeed within any
    `per_seconds` window. Concurrent callers are serialised on an internal lock so the window
    deque mutates atomically across the awaits (mirrors the EODHD limiter's `tail` chaining)."""

    def __init__(
        self,
        max_calls: int,
        per_seconds: float,
        *,
        now: Callable[[], float] | None = None,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        if max_calls < 1:
            raise ValueError("max_calls must be >= 1")
        if per_seconds <= 0:
            raise ValueError("per_seconds must be > 0")
        self._max = max_calls
        self._window_s = per_seconds
        # Monotonic clock by default — wall-clock jumps must not let a burst through or stall it.
        self._now = now or time.monotonic
        self._sleep = sleep or asyncio.sleep
        self._calls: deque[float] = deque()
        self._lock = asyncio.Lock()

    def _evict(self, at: float) -> None:
        cutoff = at - self._window_s
        while self._calls and self._calls[0] <= cutoff:
            self._calls.popleft()

    async def acquire(self) -> None:
        """Block until a request slot is free, then record the call. Never raises."""
        async with self._lock:
            while True:
                now = self._now()
                self._evict(now)
                # Free slot, or an empty window (admit a lone call so we never deadlock).
                if len(self._calls) < self._max or not self._calls:
                    self._calls.append(now)
                    return
                # Window full: wait just past the moment the oldest call leaves it. +1ms slop so
                # the slot has genuinely expired by the time we re-check (mirrors the EODHD +50ms).
                oldest = self._calls[0]
                wait_s = (oldest + self._window_s) - now + 0.001
                await self._sleep(max(wait_s, 0.0))
