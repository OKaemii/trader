"""fundamentals-api — the read-side of the PIT Fundamentals Warehouse (epic Task 11).

Serves the point-in-time fundamentals the live seam (strategy-engine, epic Task 14) and the headline
`get_pit_fundamentals(symbols, as_of)` guarantee read off the bi-temporal `fundamentals` table the
write-side (fundamentals-ingestion, Tasks 4-9) lands. The look-ahead guard is in SQL (`knowledge_ts <=
asOf` in the resolver query), never in app code.

INGRESS — the chosen collision-free mount (the card's critical constraint). The read API mounts under a
DISTINCT prefix `/admin/api/fundamentals-pit` (admin) + `/internal/api/fundamentals-pit` (the seam hot
path) so it:
  * does NOT steal `/internal/api/fundamentals`, which market-data-service already serves today (the
    Yahoo QMJ path strategy-engine reads in-cluster — NOT via the ingress; different mechanism), nor
  * collide with `/admin/api/fundamentals-ingest` (the write-side service, epic Task 3), nor
  * the bare `/admin/api/fundamentals` (which 307s to the portal today).
nginx ingress longest-prefix matching keeps all three distinct: `/admin/api/fundamentals-pit`,
`/admin/api/fundamentals-ingest`, and the bare `/admin/api/fundamentals` are mutually non-prefixing, so
each resolves to its own backend. Task 14's live seam calls this service IN-CLUSTER
(`http://fundamentals-api:8011/internal/api/fundamentals-pit?…`), not through the ingress; exposing
`/internal/api/fundamentals-pit` on the ingress too is harmless (and lets the headline `/pit` QA run).

The app is thin (mirrors backtest-engine / fundamentals-ingestion `main.py`): the resolver + pool +
security-master modules are side-effect-free and open no socket on import; the DB drivers (asyncpg,
redis) are imported lazily inside the request handlers so the module-import smoke test stays driver-free
and `/health` is independent of the warehouse being up. The cluster has no fundamentals rows until the
operator runs the Task-9 backfill, so a live read legitimately returns empty (200 with `{}` per name) —
that is correct, not a failure; the resolver's correctness is proven by the unit suite.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse

# Connection coordinates the read path uses (read at boot so a missing var surfaces here, not mid-request).
# The app does not open a pool on import — the resolver/pool modules own that on first request.
TIMESCALE_URL = os.getenv("TIMESCALE_URL", "postgresql://localhost:5432/trader_ts")
REDIS_URL = os.getenv("REDIS_URL", "redis://redis:6379")

SERVICE_NAME = "fundamentals-api"

app = FastAPI(title=SERVICE_NAME, version="0.1.0")


@app.exception_handler(Exception)
async def _json_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Always answer with JSON. Starlette's default 500 is a *plain-text* body, which the portal proxy
    mislabels as JSON and the browser then fails to parse (same guard as backtest-engine / ingestion)."""
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


def _health() -> dict:
    return {"status": "ok", "service": SERVICE_NAME}


@app.get("/health")
async def health() -> dict:
    return _health()


@app.get("/admin/api/fundamentals-pit/health")
async def admin_health_aliased() -> dict:
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only, so the bare
    # /health is not reachable through the admin ingress — this alias is).
    return _health()


def _parse_tickers(raw: Optional[str]) -> list[str]:
    """Split a comma-separated tickers/symbols query param into a de-duplicated, order-preserving list.
    Empty/None → []."""
    if not raw:
        return []
    seen: set[str] = set()
    out: list[str] = []
    for tok in raw.split(","):
        t = tok.strip()
        if t and t not in seen:
            seen.add(t)
            out.append(t)
    return out


async def _build_resolver():
    """Construct the as-of resolver with a live Timescale pool, the security-master resolver, and a Redis
    read-through cache. Lazy imports keep the module-import smoke test driver-free (asyncpg/redis are only
    needed to serve a read, not to import the app). A Redis-construction failure degrades to an
    uncached resolver (the warehouse read still works) rather than failing the request."""
    from src.pool import get_pool
    from src.resolver import FundamentalsResolver
    from src.security_master import SecurityMasterResolver

    pool = await get_pool()
    sec = SecurityMasterResolver(pool)
    redis = None
    try:
        import redis.asyncio as aioredis

        redis = aioredis.from_url(REDIS_URL, decode_responses=True)
    except Exception:  # noqa: BLE001 — cache is best-effort; an uncached resolver is still correct
        redis = None
    return FundamentalsResolver(pool, sec, redis=redis)


async def _resolve_payload(tickers: list[str], as_of_ms: Optional[int]) -> dict:
    """Resolve `tickers` as-of and shape the `{ "fundamentals": { ticker: {<line items>, source,
    observation_ts, knowledge_ts} } }` response (the plan §5 shape). Names that don't resolve / have no
    fact ≤ asOf are present with an empty line-item dict + null provenance — never dropped silently, never
    fabricated."""
    resolver = await _build_resolver()
    resolved = await resolver.get_pit_fundamentals(tickers, as_of_ms)
    return {
        "fundamentals": {ticker: tf.to_payload() for ticker, tf in resolved.items()},
        "asOf": as_of_ms,
        "count": len(resolved),
    }


@app.get("/internal/api/fundamentals-pit")
async def internal_fundamentals(
    tickers: Optional[str] = Query(
        default=None, description="Comma-separated T212 tickers (e.g. AAPL_US_EQ,MSFT_US_EQ)."
    ),
    asOf: Optional[int] = Query(  # noqa: N803 — the wire param is camelCase asOf (matches bars/pg-bar-reader)
        default=None,
        description="Knowledge-time cutoff (UTC ms). Omit = 'as of now' (the partial-unique fast lane).",
    ),
) -> JSONResponse:
    """The seam HOT PATH (epic Task 14 calls this in-cluster). Per-ticker point-in-time line items as
    known at `asOf` (omit for live). Look-ahead is impossible: the resolver's as-of query filters
    `knowledge_ts <= asOf` in SQL. Degrades a cold-warehouse error to a JSON 503 (a read over a possibly-
    unseeded warehouse must not surface as a bare 500); `/health` stays independent of the warehouse."""
    try:
        payload = await _resolve_payload(_parse_tickers(tickers), asOf)
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001 — degrade a warehouse/cache outage to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"fundamentals read unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/pit")
async def admin_pit(
    symbols: Optional[str] = Query(
        default=None, description="Comma-separated symbols (T212 tickers, e.g. AAPL_US_EQ,MSFT_US_EQ)."
    ),
    as_of: Optional[int] = Query(
        default=None,
        description="Knowledge-time cutoff (UTC ms). Omit = live. Returns ONLY facts with knowledge_ts ≤ as_of.",
    ),
) -> JSONResponse:
    """THE HEADLINE — `get_pit_fundamentals(symbols, as_of)`. Returns only facts whose `knowledge_ts ≤
    as_of` (no look-ahead — the guard is in the resolver's SQL). Same backing resolver as the internal
    seam path; this admin surface is the operator/QA view of the PIT guarantee. Accepts both `as_of` (the
    plan's headline spelling) here; the internal seam uses `asOf` (the bars/pg-bar-reader spelling)."""
    try:
        payload = await _resolve_payload(_parse_tickers(symbols), as_of)
        return JSONResponse(content=payload)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=503,
            content={"detail": f"pit read unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/coverage")
async def admin_coverage() -> JSONResponse:
    """Coverage summary over the canonical `fundamentals` table: distinct instruments with at least one
    current fact, total current facts, and the oldest observation period covered. The operator's "how
    much has the backfill landed" view. Degrades a cold/empty warehouse to a 200 with zeroes (an unseeded
    warehouse legitimately has none — that is not an error) and a Timescale-unreachable error to a 503."""
    try:
        from src.pool import get_pool

        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT
                    COUNT(DISTINCT instrument_id)        AS instruments,
                    COUNT(*)                             AS facts,
                    MIN(observation_ts)                  AS oldest_observation_ts,
                    MAX(knowledge_ts)                    AS newest_knowledge_ts
                FROM fundamentals
                WHERE is_superseded = FALSE
                """
            )
        return JSONResponse(
            content={
                "instruments": int(row["instruments"] or 0),
                "facts": int(row["facts"] or 0),
                "oldest_observation_ts": (
                    int(row["oldest_observation_ts"]) if row["oldest_observation_ts"] is not None else None
                ),
                "newest_knowledge_ts": (
                    int(row["newest_knowledge_ts"]) if row["newest_knowledge_ts"] is not None else None
                ),
            }
        )
    except Exception as exc:  # noqa: BLE001 — a Timescale-unreachable read degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"coverage unavailable: {type(exc).__name__}: {exc}"},
        )


@app.get("/admin/api/fundamentals-pit/quarantine")
async def admin_quarantine(
    since_ms: Optional[int] = Query(
        default=None, description="Only count quarantine events at/after this UTC-ms instant (omit = all time)."
    ),
    limit: int = Query(
        default=50, ge=1, le=500, description="Max recent quarantine rows to sample."
    ),
) -> JSONResponse:
    """QA quarantine view (by-reason counts + a recent sample) over `fundamentals_quarantine` — the
    facts/filings the write-side QA engine + writer held out of the canonical table. The plan offers
    EITHER a read-side quarantine surface here OR reusing the write-side ingestion endpoint; this serves
    it from the read side (operators land on the read API for the PIT surface) over the same table. A
    Timescale-unreachable error degrades to a JSON 503."""
    try:
        from src.pool import get_pool

        pool = await get_pool()
        rows_by_reason: dict[str, int] = {}
        sample: list[dict] = []
        async with pool.acquire() as conn:
            reason_rows = await conn.fetch(
                """
                SELECT reason, COUNT(*) AS n
                FROM fundamentals_quarantine
                WHERE ($1::bigint IS NULL OR (EXTRACT(EPOCH FROM occurred_at) * 1000) >= $1)
                GROUP BY reason
                ORDER BY n DESC, reason ASC
                """,
                since_ms,
            )
            for r in reason_rows:
                rows_by_reason[r["reason"]] = int(r["n"])
            recent = await conn.fetch(
                """
                SELECT event_id, occurred_at, instrument_id, filing_id, reason, payload
                FROM fundamentals_quarantine
                WHERE ($1::bigint IS NULL OR (EXTRACT(EPOCH FROM occurred_at) * 1000) >= $1)
                ORDER BY occurred_at DESC
                LIMIT $2
                """,
                since_ms, limit,
            )
            for r in recent:
                sample.append(
                    {
                        "event_id": int(r["event_id"]),
                        "instrument_id": (int(r["instrument_id"]) if r["instrument_id"] is not None else None),
                        "filing_id": (int(r["filing_id"]) if r["filing_id"] is not None else None),
                        "reason": r["reason"],
                        "payload": r["payload"],
                    }
                )
        return JSONResponse(
            content={
                "total": sum(rows_by_reason.values()),
                "by_reason": rows_by_reason,
                "recent": sample,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            }
        )
    except Exception as exc:  # noqa: BLE001 — a warehouse outage degrades to 503, never a bare 500
        return JSONResponse(
            status_code=503,
            content={"detail": f"quarantine report unavailable: {type(exc).__name__}: {exc}"},
        )
