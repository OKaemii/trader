"""Lake store + Redis singletons for the lake-backed read side (epic Task 10).

This replaces the old asyncpg-pool module (`pool.py`, the Timescale `fundamentals` reader) with the
PIT-fundamentals **lake** reader: `quant_core.fundamentals.lake.store.Store`, a read-only
DuckDB-over-Parquet engine targeting one per-CIK file on the hot path (no chunk fan, no OOM). The lake
is the immutable source of truth — the whole PIT guarantee is the store's two SQL clauses
(`knowledge_ts <= as_of` + `row_number() … = 1`), so this service holds NO Postgres connection at all.

`get_store()` is a process singleton: the `Store` constructs an in-memory DuckDB connection (which is
NOT thread-safe — it serialises every query on a lock) and opens NO Parquet view up front, so it
constructs cleanly over a cold lake (the harvester may still be bootstrapping). Reused across requests
because the connection is stateful; building one per request on the seam hot path would churn DuckDB
connections needlessly.

`get_redis()` is carried over verbatim from the old pool module — the read-through cache front and the
shared FX-key reader the Gap-2 enrichment uses (`market_cap.py`). A build failure degrades to None
(uncached, still-correct reads), never a failed import.

`FUNDAMENTALS_LAKE_DIR` is the RO-mounted lake path (the harvester owns the RW mount; this service and
backtest-engine mount it read-only). Read at module load purely so a missing/odd value is visible at
boot; `get_store()` re-reads it. Driver imports (duckdb/pyarrow via quant-core's `[lake]` extra, redis)
stay lazy/at-construction so the module-import smoke test is driver-light and `/health` is independent
of the lake being populated.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

# The RO-mounted lake root (harvester writes it RW; this service mounts it RO — same hostPath PV as
# /srv/warehouse). The default matches the chart mount path so a missing env surfaces at store-open.
DEFAULT_LAKE_DIR = "/srv/fundamentals-lake"
DEFAULT_REDIS_URL = "redis://redis:6379"

_store = None  # process-wide lake Store singleton (one DuckDB connection), created on first use.

_redis = None  # process-wide redis.asyncio client singleton (one backing connection pool).


def lake_dir() -> str:
    """The lake root the read engine reads (env, with the in-cluster mount default)."""
    return os.getenv("FUNDAMENTALS_LAKE_DIR", DEFAULT_LAKE_DIR)


def redis_url() -> str:
    """The Redis URL the read-through cache fronts (env, with the in-cluster default)."""
    return os.getenv("REDIS_URL", DEFAULT_REDIS_URL)


def get_store():
    """Return the process-wide lake `Store`, creating it on first call.

    Construction is synchronous and side-effect-light: the `Store` opens an in-memory DuckDB connection
    and creates NO view (each query parameterises `read_parquet(?)` against the concrete per-CIK file it
    needs and short-circuits when that file is absent), so it constructs cleanly over a cold lake. The
    `quant-core[lake]` extra (duckdb + pyarrow) is imported here, not at module top, so importing this
    module for the smoke test doesn't require the lake drivers."""
    global _store
    if _store is not None:
        return _store
    from quant_core.fundamentals.lake.store import Store  # local import: keep the smoke test driver-light

    _store = Store(Path(lake_dir()))
    return _store


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


def reset_store() -> None:
    """Drop the singleton lake Store (test teardown / a lake remount). Idempotent. The DuckDB
    connection is closed best-effort so a re-`get_store()` opens a fresh one."""
    global _store
    if _store is not None:
        try:
            _store.con.close()
        except Exception:  # noqa: BLE001 — teardown best-effort
            pass
        _store = None


async def close_redis() -> None:
    """Close the singleton redis client (graceful shutdown / test teardown). Idempotent."""
    global _redis
    if _redis is not None:
        try:
            await _redis.aclose()
        except Exception:  # noqa: BLE001 — teardown best-effort
            pass
        _redis = None
