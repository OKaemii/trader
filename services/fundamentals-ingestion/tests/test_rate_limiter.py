"""RateLimiter tests — the async sliding-window limiter (mirrors EodhdCreditLimiter).

Driven on VIRTUAL time (injected `now`/`sleep`) so there are no real sleeps in the gate: the fake
clock advances exactly by the limiter's requested sleep, and we assert the limiter blocks at the
window boundary and admits again once the oldest call has aged out."""
from __future__ import annotations

import pytest

from src.security_master.rate_limiter import RateLimiter


class _Clock:
    """A controllable monotonic clock whose `sleep` advances time by the slept amount — so a limiter
    that 'waits' for a slot makes deterministic progress with no wall-clock delay."""

    def __init__(self) -> None:
        self.t = 0.0
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds


@pytest.mark.asyncio
async def test_admits_up_to_max_without_sleeping() -> None:
    clock = _Clock()
    rl = RateLimiter(3, 1.0, now=clock.now, sleep=clock.sleep)
    for _ in range(3):
        await rl.acquire()
    assert clock.slept == []           # 3 within the window: no wait


@pytest.mark.asyncio
async def test_blocks_until_oldest_leaves_window() -> None:
    clock = _Clock()
    rl = RateLimiter(2, 10.0, now=clock.now, sleep=clock.sleep)
    await rl.acquire()                 # t=0
    await rl.acquire()                 # t=0 (window now full: 2 calls)
    await rl.acquire()                 # must wait until t≈10 (oldest ages out)
    assert clock.slept                 # it slept
    assert clock.t >= 10.0             # advanced past the window


@pytest.mark.asyncio
async def test_oldest_eviction_frees_a_slot() -> None:
    clock = _Clock()
    rl = RateLimiter(1, 5.0, now=clock.now, sleep=clock.sleep)
    await rl.acquire()                 # t=0
    clock.t = 6.0                      # manually advance past the window
    await rl.acquire()                 # oldest evicted → no sleep needed
    # The second acquire after the window should not have slept (the first call already aged out).
    assert clock.slept == []


def test_constructor_validates_args() -> None:
    with pytest.raises(ValueError):
        RateLimiter(0, 1.0)
    with pytest.raises(ValueError):
        RateLimiter(1, 0.0)
