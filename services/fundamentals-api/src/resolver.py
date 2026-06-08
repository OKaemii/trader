"""The point-in-time as-of resolver — the heart of epic Task 11.

`get_pit_fundamentals(tickers, as_of_ms)` answers "what fundamentals were KNOWABLE for these names on
`as_of`?" by reading the bi-temporal `fundamentals` table the write-side (Task 7 writer) lands, and
pivoting the long facts into the snake_case line-item dict the factors + QMJ screen read. It mirrors
`packages/shared-bars/src/pg-bar-reader.ts` 1:1 — the SAME bi-temporal read shape, just keyed on a
fact tuple `(instrument_id, metric, observation_ts, dim_signature)` instead of a bar's `observation_ts`:

  Live path (no asOf)  — the `fundamentals_latest_unique` partial-unique index fast lane:
                         `WHERE is_superseded = FALSE`. Exactly one current row per logical fact, one
                         index scan, no aggregation. (Same cost shape as bars' live read.)
  As-of path (asOf)    — `DISTINCT ON (metric, observation_ts, dim_signature) … WHERE knowledge_ts <= $asOf
                         ORDER BY metric, observation_ts, dim_signature, knowledge_ts DESC`. PG's native
                         equivalent of Mongo's `$sort + $group({$first})`; the `fundamentals_knowledge_lookup`
                         index covers the range scan, DISTINCT ON does the per-logical-fact latest-≤-asOf pick.

THE NO-LOOK-AHEAD INVARIANT IS IN SQL, NOT APP CODE (the card's hard constraint). The `knowledge_ts <= $asOf`
predicate lives in the query — a fact from a filing accepted (and so made knowable) after `as_of` is never
returned, because the database never hands it to us. There is no app-layer date filter that a refactor could
drop; the guard is the WHERE clause.

THE PIVOT. Each surviving fact is one canonical `metric` (a `quant_core.fundamentals.LINE_ITEMS` key) with a
`value`. We collapse a name's facts to the MOST-RECENT observation per metric (the latest fiscal period whose
availability ≤ asOf) and emit `{metric: value, …}` plus the provenance triple `source` / `observation_ts` /
`knowledge_ts` (carried from the metric that drove the as-of, so a consumer can see how stale the snapshot is).
LINE_ITEMS is IMPORTED, never re-listed — that is the whole point of the shared contract (writer emits these
spellings, reader reads them; they cannot drift).

PERIOD SELECTION. A name has many `(metric, observation_ts)` facts (FY2018, FY2019, …). The factors want the
latest *annual* figure knowable as-of, so per (metric, dim='') we keep the row with the greatest `observation_ts`
among those that survived the knowledge_ts filter. Segment facts (`dim_signature != ''`) are dropped from the
consolidated line-item dict — the canonical dict is the consolidated view (the writer already isolates segments
into their own dim_signature; the factors read consolidated totals).

INSTRUMENT RESOLUTION. The `fundamentals` PK keys on `instrument_id`, but callers speak T212 tickers, so we
resolve ticker → instrument_id via the `security_master` (effective-dated, as-of aware: `resolve_symbol`/
`resolve_instrument` from the write-side service's resolver, reused here). A ticker that doesn't resolve, or a
covered ticker with no fact ≤ asOf, yields `{}` for that name — never a fabricated value (the forward-only
degrade the seam contract mandates). The cluster has no fundamentals rows until the operator runs the Task-9
backfill, so the live read is legitimately empty today; the resolver is proven correct via the unit suite.

CACHE. Redis read-through, mirroring pg-bar-reader: Redis-first → Postgres-on-miss → populate. The cache key
includes a 60-second `asOf` bucket so live consumers share one entry and an audit at a fixed instant is stable;
a cache read/write failure NEVER blocks a request (it falls through to Postgres). Namespace `fund:pg:v1:` is
distinct from the bars `bars:pg:v1:` so the two never collide.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

from quant_core.fundamentals import (
    LINE_ITEMS,
    MARKET_UK,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    market_of,
)

from src.market_cap import (
    apply_dividend_yield,
    apply_pit_market_cap,
    compute_market_cap_gbp,
    currency_of,
)

log = logging.getLogger("fundamentals-api.resolver")

# Cache TTL + key namespace mirror pg-bar-reader.ts. v1 + a distinct `fund:` prefix so the bars cache
# and this cache never share a key even though both front a Timescale bi-temporal read.
CACHE_TTL_SECONDS = 3600
_CACHE_PREFIX = "fund:pg:v1"

# The line-item metric set we project. IMPORTED from the shared contract — the as-of read pivots its
# long facts INTO exactly these keys, so the writer (which emits these spellings) and this reader cannot
# drift. A metric a source never supplied is simply absent from a name's dict (the factor NaN-excludes
# it; never a fabricated 0).
LINE_ITEM_SET = set(LINE_ITEMS)


def as_of_bucket(as_of_ms: Optional[int]) -> str:
    """Cache-key bucket for the knowledge-time cutoff. `None` (live) → 'live'; otherwise a 60s bucket so
    live consumers calling with ≈now share one entry (mirror pg-bar-reader.ts asOfBucket)."""
    if as_of_ms is None:
        return "live"
    return str(as_of_ms // 60_000)


def cache_key(ticker: str, as_of_ms: Optional[int]) -> str:
    """Redis key for one name's resolved line-item dict at an asOf bucket."""
    return f"{_CACHE_PREFIX}:{ticker}:{as_of_bucket(as_of_ms)}"


def source_for(ticker: str) -> str:
    """The PIT `source` stamp a covered name's facts carry, by jurisdiction (mirror the seam's
    `source_for`): UK → Companies House, else US EDGAR. The actual `source` column on each row is
    authoritative; this is the expected stamp for routing/provenance."""
    return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR


@dataclass(frozen=True)
class TickerFundamentals:
    """One name's resolved point-in-time line items + provenance. `line_items` are the snake_case
    `LINE_ITEMS` keys present for this name as-of (absent keys are genuinely unavailable, not 0).
    `observation_ts`/`knowledge_ts` are carried from the latest-driving fact so a consumer sees the
    fiscal period + the availability instant behind the snapshot; `source` is the row's PIT stamp."""

    line_items: dict[str, float]
    source: Optional[str]
    observation_ts: Optional[int]
    knowledge_ts: Optional[int]

    def to_payload(self) -> dict[str, Any]:
        """The JSON shape the seam's hot path returns per ticker: the line items spread at the top
        level + the provenance triple alongside (matches the plan's §5 response shape)."""
        out: dict[str, Any] = dict(self.line_items)
        out["source"] = self.source
        out["observation_ts"] = self.observation_ts
        out["knowledge_ts"] = self.knowledge_ts
        return out


# ── SQL ────────────────────────────────────────────────────────────────────────
# Live fast lane — the partial-unique index `fundamentals_latest_unique` picks exactly one current row
# per logical fact. No knowledge_ts predicate (the current row IS "as of now").
_SELECT_LIVE = """
SELECT metric, observation_ts, knowledge_ts, dim_signature, value, source
FROM fundamentals
WHERE instrument_id = $1
  AND is_superseded = FALSE
  AND dim_signature = ''
ORDER BY metric, observation_ts DESC
"""

# As-of path — DISTINCT ON the logical fact, latest revision with knowledge_ts ≤ asOf. This is the PG
# native equivalent of `$sort + $group({$first})`; `fundamentals_knowledge_lookup` covers the range.
# The NO-LOOK-AHEAD GUARD is the `knowledge_ts <= $2` clause here, in SQL — never in app code.
_SELECT_AS_OF = """
SELECT DISTINCT ON (metric, observation_ts, dim_signature)
       metric, observation_ts, knowledge_ts, dim_signature, value, source
FROM fundamentals
WHERE instrument_id = $1
  AND knowledge_ts <= $2
  AND dim_signature = ''
ORDER BY metric, observation_ts, dim_signature, knowledge_ts DESC
"""


def _pivot_rows(rows: list[dict[str, Any]]) -> TickerFundamentals:
    """Collapse a name's surviving consolidated facts to the latest-observation value per metric, into
    the snake_case line-item dict + provenance. `rows` are already filtered (knowledge_ts ≤ asOf for the
    as-of path; is_superseded=FALSE for live) and dim_signature='' (consolidated). We pick, per metric,
    the greatest observation_ts (the most recent fiscal period knowable as-of), and carry the provenance
    of the single most-recent driving fact across the whole name."""
    by_metric: dict[str, dict[str, Any]] = {}
    for r in rows:
        metric = r["metric"]
        if metric not in LINE_ITEM_SET:
            # A row whose metric isn't a current LINE_ITEMS key (a writer ran ahead of the contract).
            # Skip it rather than leak an unknown key into the factor dict — the contract pins spelling.
            continue
        if r["value"] is None:
            continue
        obs = int(r["observation_ts"])
        cur = by_metric.get(metric)
        if cur is None or obs > int(cur["observation_ts"]):
            by_metric[metric] = r

    line_items: dict[str, float] = {m: float(r["value"]) for m, r in by_metric.items()}

    # Provenance: the single most-recent driving fact across the whole name (greatest observation_ts,
    # tie-broken by knowledge_ts) so a consumer reads ONE coherent (source, period, availability) triple
    # for the snapshot. None when the name has no facts.
    driving = None
    for r in by_metric.values():
        if driving is None:
            driving = r
            continue
        if (int(r["observation_ts"]), int(r["knowledge_ts"])) > (
            int(driving["observation_ts"]),
            int(driving["knowledge_ts"]),
        ):
            driving = r

    if driving is None:
        return TickerFundamentals(line_items={}, source=None, observation_ts=None, knowledge_ts=None)
    return TickerFundamentals(
        line_items=line_items,
        source=driving["source"],
        observation_ts=int(driving["observation_ts"]),
        knowledge_ts=int(driving["knowledge_ts"]),
    )


class FundamentalsResolver:
    """As-of read over `fundamentals`, ticker → instrument_id via the security master, Redis read-through.

    Inject an asyncpg.Pool (the Timescale reader — `security_master.pool.get_pool`), a security-master
    resolver (ticker → instrument_id), and optionally a redis client (the read-through cache front; a
    None client disables caching — useful in tests). Holds no global state and opens no socket on import.

    `market_data` (optional `src.market_cap.MarketDataReader`) is the Gap-2 enrichment edge: when present,
    the resolver OVERRIDES each covered name's `market_cap_gbp` with the computed PIT value
    (adjusted_close(as_of) × shares_outstanding(as_of) × fx_to_gbp) and wires the PIT `dividend_yield`
    leg, so Value's three legs share one as-of basis and earnings_yield/book_to_market are point-in-time.
    None (tests / a degraded boot) leaves the warehouse pivot untouched — the warehouse never stores a
    provider market-cap scalar (the writer doesn't land `market_cap_gbp`), so without the reader the key
    is simply absent (the factor NaN-excludes it), never a fabricated value. The enrichment runs OUTSIDE
    the Redis cache (below) so it always uses fresh price/FX/dividends while the slow warehouse read stays
    cached."""

    def __init__(self, pool, resolver, redis=None, market_data=None) -> None:
        self._pool = pool
        self._resolver = resolver
        self._redis = redis
        self._market_data = market_data

    async def _instrument_id(self, ticker: str, as_of_ms: Optional[int]) -> Optional[int]:
        """Resolve a T212 ticker to its instrument_id via the security master, as-of aware. A ticker
        that doesn't resolve (no security-master row yet, or a non-covered name) → None, and the caller
        degrades that name to `{}` (never a fabricated id/value)."""
        resolved = await self._resolver.resolve_instrument(ticker, as_of_ms)
        return resolved.instrument_id if resolved is not None else None

    async def _read_rows(self, instrument_id: int, as_of_ms: Optional[int]) -> list[dict[str, Any]]:
        """Run the live or as-of SELECT for one resolved instrument. The query carries the
        knowledge_ts ≤ asOf guard (as-of path) — the no-look-ahead invariant is here, in SQL."""
        async with self._pool.acquire() as conn:
            if as_of_ms is None:
                records = await conn.fetch(_SELECT_LIVE, instrument_id)
            else:
                records = await conn.fetch(_SELECT_AS_OF, instrument_id, as_of_ms)
        return [dict(r) for r in records]

    async def _resolve_one(self, ticker: str, as_of_ms: Optional[int]) -> TickerFundamentals:
        """Resolve ONE name: ticker → instrument_id → as-of rows → pivot. Empty on an unresolved ticker
        or no fact ≤ asOf (the forward-only degrade)."""
        instrument_id = await self._instrument_id(ticker, as_of_ms)
        if instrument_id is None:
            return TickerFundamentals(line_items={}, source=None, observation_ts=None, knowledge_ts=None)
        rows = await self._read_rows(instrument_id, as_of_ms)
        return _pivot_rows(rows)

    async def _cache_get(self, ticker: str, as_of_ms: Optional[int]) -> Optional[TickerFundamentals]:
        """Redis-first read (mirror pg-bar-reader). A cache miss or any failure returns None and the
        caller falls through to Postgres — the cache never blocks a request."""
        if self._redis is None:
            return None
        key = cache_key(ticker, as_of_ms)
        try:
            cached = await self._redis.get(key)
            if cached is None:
                return None
            data = json.loads(cached)
            if data.get("v") != 1:
                return None
            return TickerFundamentals(
                line_items={k: float(v) for k, v in (data.get("line_items") or {}).items()},
                source=data.get("source"),
                observation_ts=data.get("observation_ts"),
                knowledge_ts=data.get("knowledge_ts"),
            )
        except Exception as exc:  # noqa: BLE001 — a cache read failure never blocks a request
            log.warning("[resolver] cache read failed for %s: %s", key, exc)
            return None

    async def _cache_set(self, ticker: str, as_of_ms: Optional[int], result: TickerFundamentals) -> None:
        """Populate the read-through cache (best-effort)."""
        if self._redis is None:
            return
        key = cache_key(ticker, as_of_ms)
        payload = json.dumps(
            {
                "v": 1,
                "line_items": result.line_items,
                "source": result.source,
                "observation_ts": result.observation_ts,
                "knowledge_ts": result.knowledge_ts,
            }
        )
        try:
            await self._redis.set(key, payload, ex=CACHE_TTL_SECONDS)
        except Exception as exc:  # noqa: BLE001 — a cache write failure never blocks a request
            log.warning("[resolver] cache write failed for %s: %s", key, exc)

    async def get_pit_fundamentals(
        self, tickers: list[str], as_of_ms: Optional[int] = None
    ) -> dict[str, TickerFundamentals]:
        """THE HEADLINE. Resolve point-in-time line items for `tickers` as known at `as_of_ms`.

        `as_of_ms=None` is the live fast lane (current rows); a past `as_of_ms` returns ONLY facts whose
        `knowledge_ts <= as_of_ms` (the guard is in SQL). Names that don't resolve, or have no fact ≤ asOf,
        are present in the result with an empty `line_items` dict (the caller can choose to include or drop
        them) — never a fabricated value. Redis read-through fronts the WAREHOUSE pivot per name; a cache
        failure degrades to a direct Postgres read.

        Gap-2 ENRICHMENT (when a `MarketDataReader` is injected) runs AFTER the cache layer, on the merged
        warehouse result: each covered name's `market_cap_gbp` is overridden with the computed PIT value
        (price×shares×fx) and the PIT `dividend_yield` leg is wired in — both from the fresh in-cluster
        reads (market-data's own Redis cache keeps them cheap), so the slow warehouse read stays cached
        while the fast-moving price/FX/dividend inputs are never stale-cached against an old market cap."""
        out: dict[str, TickerFundamentals] = {}
        for ticker in tickers:
            cached = await self._cache_get(ticker, as_of_ms)
            if cached is not None:
                out[ticker] = cached
                continue
            resolved = await self._resolve_one(ticker, as_of_ms)
            await self._cache_set(ticker, as_of_ms, resolved)
            out[ticker] = resolved
        return await self._enrich_market_data(out, as_of_ms)

    async def _enrich_market_data(
        self, resolved: dict[str, TickerFundamentals], as_of_ms: Optional[int]
    ) -> dict[str, TickerFundamentals]:
        """Override `market_cap_gbp` with the computed PIT value + wire the PIT `dividend_yield` leg
        (Gap 2). No-op when no `MarketDataReader` is injected. Computes market cap per name from the as-of
        adjusted close (the SAME series momentum uses) × the name's as-of `shares_outstanding` (the dei
        cover-page fact already in `line_items`) × FX→GBP, and drops the key when any input is missing
        (NaN-excluded, never a fabricated 0). Dividend yields are fetched in ONE batch round-trip for all
        names. A name that didn't resolve (empty line items, no source) is left untouched — there's nothing
        to value."""
        if self._market_data is None:
            return resolved
        # One batch dividend-yield round-trip for every resolved name (the leg shares the as-of basis).
        dy_by_ticker = await self._market_data.dividend_yields_as_of(list(resolved.keys()), as_of_ms)
        enriched: dict[str, TickerFundamentals] = {}
        for ticker, tf in resolved.items():
            # Unresolved name (no facts at all) — nothing to compute a market cap from; pass through.
            if tf.source is None and not tf.line_items:
                enriched[ticker] = tf
                continue
            adjusted_close = await self._market_data.adjusted_close_as_of(ticker, as_of_ms)
            shares = tf.line_items.get("shares_outstanding")
            fx_rate = await self._market_data.fx_to_gbp(currency_of(ticker))
            market_cap = compute_market_cap_gbp(adjusted_close, shares, fx_rate)
            new_items = apply_pit_market_cap(tf.line_items, market_cap)
            new_items = apply_dividend_yield(new_items, dy_by_ticker.get(ticker))
            enriched[ticker] = TickerFundamentals(
                line_items=new_items,
                source=tf.source,
                observation_ts=tf.observation_ts,
                knowledge_ts=tf.knowledge_ts,
            )
        return enriched
