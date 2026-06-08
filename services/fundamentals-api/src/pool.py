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
DEFAULT_REDIS_URL = "redis://redis:6379"

_pool = None  # process-wide asyncpg.Pool singleton, created on first use.
# Guard the lazy create against an async check-then-act race (two coroutines both seeing `_pool is None`
# and each opening a pool, the second orphaning the first's connections). The lock makes init once.
_pool_lock = asyncio.Lock()

_redis = None  # process-wide redis.asyncio client singleton (one backing connection pool), created on first use.


def timescale_url() -> str:
    """The Timescale DSN the resolver reads with (env, with a localhost dev default)."""
    return os.getenv("TIMESCALE_URL", DEFAULT_TIMESCALE_URL)


def redis_url() -> str:
    """The Redis URL the read-through cache fronts (env, with the in-cluster default)."""
    return os.getenv("REDIS_URL", DEFAULT_REDIS_URL)


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


def get_redis():
    """Return the process-wide redis.asyncio client, creating it on first call. A `redis.asyncio` client
    owns a connection pool, so it MUST be constructed once and reused — building one per request (the
    seam hot path) would leak a connection pool each call. Construction is synchronous (the pool connects
    lazily on first command); a build failure returns None so the resolver degrades to an uncached (still
    correct) read rather than failing the request. `decode_responses=True` so cached JSON comes back as
    str for `json.loads`."""
    global _redis
    if _redis is not None:
        return _redis
    try:
        import redis.asyncio as aioredis  # local import: no driver needed to import/unit-test the module

        _redis = aioredis.from_url(redis_url(), decode_responses=True)
    except Exception:  # noqa: BLE001 — cache is best-effort; an uncached resolver is still correct
        _redis = None
    return _redis


async def close_pool() -> None:
    """Close the singleton pool + redis client (graceful shutdown / test teardown). Idempotent."""
    global _pool, _redis
    if _pool is not None:
        await _pool.close()
        _pool = None
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:  # noqa: BLE001 — teardown best-effort
            pass
        _redis = None
