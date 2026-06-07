"""Lazy asyncpg pool for the Timescale-backed security master.

The writers/resolver take an `asyncpg.Pool` by **injection** (the same dependency-inversion the rest
of the platform uses: `TimescaleFeatureStore(pool)`, `MarketDataClient(...)` — the concrete, volatile
connection is supplied at the composition root, never imported by the logic). This module owns only
the *construction* of that pool from `TIMESCALE_URL`, kept lazy so importing any security-master
module (and unit-testing it against a stub pool) opens **no** socket — matching the skeleton's
"the stage packages connect to nothing" invariant.

`TIMESCALE_URL` is assembled by the Deployment exactly as backtest-engine/market-data-service do
(`postgresql://trader:$(TIMESCALEDB_PASSWORD)@timescaledb-postgresql:5432/trader_ts`); we read it
here so a missing var surfaces at pool-open, not mid-ingest. The pool is a process singleton created
on first `get_pool()` and reused — asyncpg pools are concurrency-safe and the CronJob worker holds one
for the life of a run.
"""
from __future__ import annotations

import os
from typing import Optional

# asyncpg is imported lazily inside get_pool() so that merely importing this module (which the
# module-import smoke test does) needs no driver socket and no event loop — only the actual
# pool open requires asyncpg, which is installed in the service image.

DEFAULT_TIMESCALE_URL = "postgresql://localhost:5432/trader_ts"

_pool = None  # process-wide asyncpg.Pool singleton, created on first use.


def timescale_url() -> str:
    """The Timescale DSN the writer/resolver connect with (env, with a localhost dev default)."""
    return os.getenv("TIMESCALE_URL", DEFAULT_TIMESCALE_URL)


async def get_pool(dsn: Optional[str] = None, *, min_size: int = 1, max_size: int = 4):
    """Return the process-wide asyncpg pool, creating it on first call.

    Small bounds (1–4): the security-master write path is low-QPS (a few upserts per company during
    a backfill), not the hot bars read path, so a wide pool would just hold idle connections.
    """
    global _pool
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
