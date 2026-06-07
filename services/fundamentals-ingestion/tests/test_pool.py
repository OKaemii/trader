"""Pool singleton tests — the lazy asyncpg pool is created exactly once, even under concurrent
first-callers (the check-then-act race the lock guards). No real Postgres: `asyncpg.create_pool` is
monkeypatched to a counter so we assert invocation count, not a live connection."""
from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio

from src.security_master import pool as pool_mod


class _FakePool:
    def __init__(self) -> None:
        self.closed = False

    async def close(self) -> None:
        self.closed = True


@pytest_asyncio.fixture(autouse=True)
async def _reset_pool():
    # Each test starts and ends with no singleton so cases don't leak into one another.
    await pool_mod.close_pool()
    yield
    await pool_mod.close_pool()


@pytest.mark.asyncio
async def test_get_pool_creates_once_and_caches(monkeypatch) -> None:
    calls = {"n": 0}

    async def fake_create_pool(dsn, **kw):
        calls["n"] += 1
        return _FakePool()

    monkeypatch.setattr("asyncpg.create_pool", fake_create_pool)
    a = await pool_mod.get_pool(dsn="postgresql://x/y")
    b = await pool_mod.get_pool(dsn="postgresql://x/y")
    assert a is b               # same singleton returned
    assert calls["n"] == 1      # created exactly once


@pytest.mark.asyncio
async def test_get_pool_exactly_once_under_concurrent_first_callers(monkeypatch) -> None:
    calls = {"n": 0}

    async def fake_create_pool(dsn, **kw):
        calls["n"] += 1
        # Yield control so a racing caller can interleave between the count and the return — this is
        # exactly the window the lock must close.
        await asyncio.sleep(0)
        return _FakePool()

    monkeypatch.setattr("asyncpg.create_pool", fake_create_pool)
    results = await asyncio.gather(*(pool_mod.get_pool(dsn="postgresql://x/y") for _ in range(8)))
    assert calls["n"] == 1                          # the lock made init exactly-once
    assert all(r is results[0] for r in results)    # everyone got the same pool


@pytest.mark.asyncio
async def test_close_pool_is_idempotent(monkeypatch) -> None:
    async def fake_create_pool(dsn, **kw):
        return _FakePool()

    monkeypatch.setattr("asyncpg.create_pool", fake_create_pool)
    p = await pool_mod.get_pool(dsn="postgresql://x/y")
    await pool_mod.close_pool()
    assert p.closed is True
    await pool_mod.close_pool()   # second close is a no-op, not an error


def test_timescale_url_env(monkeypatch) -> None:
    monkeypatch.delenv("TIMESCALE_URL", raising=False)
    assert pool_mod.timescale_url() == pool_mod.DEFAULT_TIMESCALE_URL
    monkeypatch.setenv("TIMESCALE_URL", "postgresql://trader:pw@host:5432/trader_ts")
    assert pool_mod.timescale_url() == "postgresql://trader:pw@host:5432/trader_ts"
