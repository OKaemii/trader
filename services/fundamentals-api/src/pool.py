"""Lazy asyncpg pool for the Timescale-backed read side.

Mirrors `services/fundamentals-ingestion/src/security_master/pool.py`: the resolver takes an
`asyncpg.Pool` by injection (dependency-inversion, as the rest of the platform does); this module owns
only the *construction* of that pool from `TIMESCALE_URL`, kept lazy so importing any read module (and
unit-testing it against a stub pool) opens NO socket. `TIMESCALE_URL` is assembled by the Deployment
exactly as backtest-engine/market-data-service/fundamentals-ingestion do
(`postgresql://trader:$(TIMESCALEDB_PASSWORD)@timescaledb-postgresql:5432/trader_ts`); we read it here
so a missing var surfaces at pool-open, not mid-request. The pool is a process singleton created on
first `get_pool()` and reused.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

DEFAULT_TIMESCALE_URL = "postgresql://localhost:5432/trader_ts"

_pool = None  # process-wide asyncpg.Pool singleton, created on first use.
# Guard the lazy create against an async check-then-act race (two coroutines both seeing `_pool is None`
# and each opening a pool, the second orphaning the first's connections). The lock makes init once.
_pool_lock = asyncio.Lock()


def timescale_url() -> str:
    """The Timescale DSN the resolver reads with (env, with a localhost dev default)."""
    return os.getenv("TIMESCALE_URL", DEFAULT_TIMESCALE_URL)


async def get_pool(dsn: Optional[str] = None, *, min_size: int = 1, max_size: int = 8):
    """Return the process-wide asyncpg pool, creating it on first call (exactly-once under the lock).

    Slightly wider bounds than the write side (1–8): the read path is the per-cycle hot path the live
    seam calls to fill the whole universe, so a few concurrent connections help; still modest (this is
    a read-through cache-fronted query, not a fan-out)."""
    global _pool
    if _pool is not None:
        return _pool
    async with _pool_lock:
        if _pool is None:
            import asyncpg  # local import: no driver needed to import/unit-test the module

            _pool = await asyncpg.create_pool(
                dsn or timescale_url(), min_size=min_size, max_size=max_size
            )
    return _pool


async def close_pool() -> None:
    """Close the singleton pool (graceful shutdown / test teardown). Idempotent."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
