"""The lake-backed point-in-time as-of resolver — the heart of the rewired read API (epic Task 10).

`get_pit_fundamentals(tickers, as_of_ms)` answers "what fundamentals were KNOWABLE for these names on
`as_of`?" by reading the PIT-fundamentals **lake** (`quant_core.fundamentals.lake`) instead of the old
Timescale `fundamentals` hypertable. The HTTP contract is byte-for-byte unchanged — the seam consumers
(strategy-engine `fundamentals_as_of.py`, market-data-service `PitFundamentalsProvider.ts`) parse the
same `{ticker: {<14 snake_case line_items>, source, observation_ts, knowledge_ts}}` shape — only the
ENGINE under it changed.

WHAT THE LAKE GIVES US (vs the old asyncpg resolver):
  * The no-look-ahead guard is the lake store's `knowledge_ts <= ?` clause IN SQL
    (`Store.pit_series` / `metric_series`), exactly as before it was the Timescale SELECT's clause — a
    fact made knowable after `as_of` is never returned because the store never hands it over. There is
    no app-layer date filter a refactor could drop.
  * A restatement is "more rows with a later `knowledge_ts`"; the store's `row_number() OVER (… ORDER BY
    knowledge_ts DESC) = 1` returns the latest-known ≤ as_of, so an as-of read at the original date
    still returns the first print. No `is_superseded` flag, no transaction log (those were the
    Timescale model).
  * Query-time standardization + Q4/TTM + the entity-SIC sector template all live in
    `lake.contract.pit_line_items` — the SAME pivot replay uses (`LakePitFundamentals`), so live and
    replay cannot drift.

TICKER → IDENTITY AT THE EDGE (transition-safe). Callers still send the legacy T212 form (`AAPL_US_EQ`)
until the storage-migration cards land, but the lake speaks `TickerIdentity {symbol, market}`. This
resolver builds an identity from each request ticker via the canonical `Trading212TickerAdapter` — which
accepts a T212 string (`from_t212`) OR a bare symbol (treated as US, the curated-US default) — so the
seam works for BOTH forms with no caller change mid-cutover. `apply_rename` (market-aware FB→META) maps
a legacy symbol so the lake resolves the surviving CIK.

GAP-2 ENRICHMENT (UNCHANGED). The market-cap (`adjusted_close × shares × fx`, null-never-£0) +
dividend-yield enrichment in `market_cap.py` is LAKE-AGNOSTIC (it operates on the `line_items` dict +
calls market-data-service over the internal-JWT HTTP path) — kept VERBATIM and run AFTER `pit_line_items`
so `market_cap_gbp` + `dividend_yield` fill the 13th/14th legs. Those reads key on the T212 ticker (the
bars view + dividend-yield endpoint use it), so the resolver carries each name's T212 form for the
enrichment edge regardless of whether the request was bare or T212.

NO YAHOO (Thread C). US miss → those legs omitted (the contract pivot already fail-closes per leg);
non-US (`market != 'US'`) → `{}` (the lake `resolve` returns None for non-US, and the contract
short-circuits). Source stamp is `pit-edgar` (any leg resolved) | `null` (a miss). The `yahoo-snapshot`
stamp + every Yahoo fallback branch are gone.

CACHE. Redis read-through (mirroring the old resolver + pg-bar-reader): Redis-first → lake-on-miss →
populate. The cache key includes a 60-second `asOf` bucket so live consumers share one entry and an
audit at a fixed instant is stable; a cache read/write failure NEVER blocks a request (it falls through
to the lake). Namespace `fund:lake:v1:` is distinct from the bars `bars:pg:v1:` and the old
`fund:pg:v1:` so the caches never collide. The Gap-2 enrichment runs OUTSIDE the cache (as before) so it
always uses fresh price/FX/dividends while the slower lake read stays cached.
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
from quant_core.fundamentals.lake.contract import pit_line_items
from quant_core.ticker_identity import TickerIdentity, Trading212TickerAdapter

from src.market_cap import (
    apply_dividend_yield,
    apply_pit_market_cap,
    compute_market_cap_gbp,
    currency_of,
)

log = logging.getLogger("fundamentals-api.resolver")

# Cache TTL + key namespace. v1 + a distinct `fund:lake:` prefix so neither the bars cache
# (`bars:pg:v1:`) nor the OLD Timescale resolver's cache (`fund:pg:v1:`) ever shares a key with the
# lake-backed read — a stale entry from the pre-cutover image can't be served by the new one.
CACHE_TTL_SECONDS = 3600
_CACHE_PREFIX = "fund:lake:v1"

# The canonical ticker adapter — the ONLY suffix parser. Used to build a `TickerIdentity` from each
# request ticker (T212 or bare) and to render the name's T212 form for the Gap-2 market-data reads.
_ADAPTER = Trading212TickerAdapter()

# The line-item metric set the seam projects. IMPORTED from the shared contract so the producer (the
# lake contract pivot) and this reader cannot drift; the pivot already emits exactly these spellings.
LINE_ITEM_SET = set(LINE_ITEMS)


def as_of_bucket(as_of_ms: Optional[int]) -> str:
    """Cache-key bucket for the knowledge-time cutoff. `None` (live) → 'live'; otherwise a 60s bucket so
    live consumers calling with ≈now share one entry (mirror the bars asOfBucket)."""
    if as_of_ms is None:
        return "live"
    return str(as_of_ms // 60_000)


def cache_key(ticker: str, as_of_ms: Optional[int]) -> str:
    """Redis key for one name's resolved line-item dict at an asOf bucket. Keyed on the ORIGINAL request
    ticker (bare or T212) so two spellings of the same name don't accidentally share a cached entry."""
    return f"{_CACHE_PREFIX}:{ticker}:{as_of_bucket(as_of_ms)}"


def source_for(ticker: str) -> str:
    """The PIT `source` stamp a covered name's facts carry, by jurisdiction (mirror the seam's
    `source_for`): UK → Companies House, else US EDGAR. With Yahoo gone (Thread C), a covered US name
    stamps `pit-edgar`; a non-US name is fail-closed `{}` so this stamp is the routing default only."""
    return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR


def identity_of(ticker: str) -> Optional[TickerIdentity]:
    """Build the canonical (rename-applied) `TickerIdentity` for a request ticker — accepting BOTH the
    legacy T212 form (`AAPL_US_EQ`, `SHELl_EQ`) and a bare symbol (`AAPL`, `GOOGL`), so the seam is
    transition-safe while callers still send T212 (note 1).

    A recognised T212 string parses via `from_t212` (the only suffix parser). A bare token (no
    `_US_EQ`/`l_EQ` suffix) is treated as a US listing — the curated-US default, matching the universe's
    US-preferred resolution; a bare LSE name would have to arrive in its T212 (`…l_EQ`) form, which is
    correct since the bare-LSE case is non-US-fundamentals (fail-closed) anyway. `apply_rename` maps a
    legacy symbol (FB→META) so the lake resolves the surviving CIK. A malformed/empty token → None (the
    caller degrades that name to `{}`)."""
    raw = (ticker or "").strip()
    if not raw:
        return None
    try:
        ident = _ADAPTER.from_t212(raw)
    except ValueError:
        # Not a recognised US/LSE T212 form — treat a bare symbol as a US listing (curated-US default).
        ident = TickerIdentity(symbol=raw, market="US")
    return _ADAPTER.apply_rename(ident)


def t212_of(ticker: str, ident: Optional[TickerIdentity]) -> str:
    """The T212 form to drive the Gap-2 market-data reads for a name (the bars view + dividend-yield
    endpoint key on the T212 string). When the request ticker is already a recognised T212 form we keep
    it verbatim (it IS the bars key); otherwise we render the identity's T212 form via the adapter (a
    bare `AAPL` → `AAPL_US_EQ`). Falls back to the raw ticker when there is no identity (an unresolved
    name is excluded from the reads anyway)."""
    raw = (ticker or "").strip()
    try:
        _ADAPTER.from_t212(raw)
        return raw  # already a T212 form — the bars view's key
    except ValueError:
        pass
    if ident is not None:
        try:
            return _ADAPTER.to_t212(ident)
        except ValueError:
            return raw
    return raw


@dataclass(frozen=True)
class TickerFundamentals:
    """One name's resolved point-in-time line items + provenance. `line_items` are the snake_case
    `LINE_ITEMS` keys present for this name as-of (absent keys are genuinely unavailable, not 0).
    `observation_ts`/`knowledge_ts` are carried from the latest-driving fact so a consumer sees the
    fiscal period + the availability instant behind the snapshot; `source` is the PIT stamp
    (`pit-edgar` for a covered US name, `None` for a miss)."""

    line_items: dict[str, float]
    source: Optional[str]
    observation_ts: Optional[int]
    knowledge_ts: Optional[int]

    def to_payload(self) -> dict[str, Any]:
        """The JSON shape the seam's hot path returns per ticker: the line items spread at the top
        level + the provenance triple alongside. BYTE-FOR-BYTE identical to the old resolver's
        `to_payload` (the seam consumers parse this exact shape) — `dict(line_items)` then the three
        provenance keys."""
        out: dict[str, Any] = dict(self.line_items)
        out["source"] = self.source
        out["observation_ts"] = self.observation_ts
        out["knowledge_ts"] = self.knowledge_ts
        return out


class FundamentalsResolver:
    """As-of read over the PIT-fundamentals lake, with the Gap-2 market-cap/dividend enrichment + a
    Redis read-through cache. Drop-in for the old Timescale resolver: the SAME class name + the SAME
    `get_pit_fundamentals(tickers, as_of_ms)` signature + the SAME `TickerFundamentals.to_payload`
    shape, so `main.py`'s handlers are unchanged.

    Inject the lake `Store` (the per-CIK Parquet read engine — `src.store.get_store`), optionally a
    redis client (the read-through cache front; None disables caching — useful in tests), and optionally
    a `market_data` reader (`src.market_cap.MarketDataReader`) for the Gap-2 enrichment. Holds no global
    state and opens no socket on import.

    `market_data` is the Gap-2 enrichment edge: when present, the resolver OVERRIDES each covered name's
    `market_cap_gbp` with the computed PIT value (adjusted_close(as_of) × shares_outstanding(as_of) ×
    fx_to_gbp) and wires the PIT `dividend_yield` leg, so Value's three legs share one as-of basis. None
    (tests / a degraded boot) leaves the lake pivot untouched — the lake never stores a provider market
    cap, so without the reader the key is simply absent (the factor NaN-excludes it), never fabricated.
    The enrichment runs OUTSIDE the Redis cache so it always uses fresh price/FX/dividends while the
    slower lake read stays cached."""

    def __init__(self, store, redis=None, market_data=None) -> None:
        self._store = store
        self._redis = redis
        self._market_data = market_data

    def _resolve_one(self, ticker: str, as_of_ms: Optional[int]) -> TickerFundamentals:
        """Resolve ONE name from the lake: request ticker → identity → `pit_line_items` (sector-aware,
        PIT-filtered in the store) → the byte-compatible `TickerFundamentals`. Empty on a non-US name,
        an unresolved/cold CIK, or no fact ≤ asOf (the forward-only, fail-closed degrade — no Yahoo).

        `as_of_ms=None` (live) is mapped to 'now' for the lake read: the lake has no `is_superseded`
        fast lane — "live" IS "as of now", so an unbounded knowledge cutoff is the current wall-clock.
        A past `as_of_ms` filters `knowledge_ts <= as_of_ms` in the store (the no-look-ahead guard)."""
        ident = identity_of(ticker)
        if ident is None:
            return TickerFundamentals(line_items={}, source=None, observation_ts=None, knowledge_ts=None)
        cutoff = as_of_ms if as_of_ms is not None else _now_ms()
        line_items, source, observation_ts, knowledge_ts = pit_line_items(self._store, ident, cutoff)
        return TickerFundamentals(
            line_items=line_items,
            source=source,
            observation_ts=observation_ts,
            knowledge_ts=knowledge_ts,
        )

    async def _cache_get(self, ticker: str, as_of_ms: Optional[int]) -> Optional[TickerFundamentals]:
        """Redis-first read. A cache miss or any failure returns None and the caller falls through to
        the lake — the cache never blocks a request."""
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

        `as_of_ms=None` is live ('as of now'); a past `as_of_ms` returns ONLY facts whose `knowledge_ts
        <= as_of_ms` (the guard is the lake store's SQL). Names that don't resolve (non-US, cold lake,
        unknown CIK), or have no fact ≤ asOf, are present in the result with an empty `line_items` dict
        and `source=None` — never a fabricated value. Redis read-through fronts the lake read per name; a
        cache failure degrades to a direct lake read.

        Gap-2 ENRICHMENT (when a `MarketDataReader` is injected) runs AFTER the cache layer, on the
        merged lake result: each covered name's `market_cap_gbp` is overridden with the computed PIT
        value (price×shares×fx) and the PIT `dividend_yield` leg is wired in — both from the fresh
        in-cluster reads (market-data's own Redis cache keeps them cheap), so the slow lake read stays
        cached while the fast-moving price/FX/dividend inputs are never stale-cached against an old
        market cap. The lake read is synchronous (DuckDB), so it runs directly; the cache + enrichment
        edges are async."""
        out: dict[str, TickerFundamentals] = {}
        for ticker in tickers:
            cached = await self._cache_get(ticker, as_of_ms)
            if cached is not None:
                out[ticker] = cached
                continue
            resolved = self._resolve_one(ticker, as_of_ms)
            await self._cache_set(ticker, as_of_ms, resolved)
            out[ticker] = resolved
        return await self._enrich_market_data(out, as_of_ms)

    async def _enrich_market_data(
        self, resolved: dict[str, TickerFundamentals], as_of_ms: Optional[int]
    ) -> dict[str, TickerFundamentals]:
        """Override `market_cap_gbp` with the computed PIT value + wire the PIT `dividend_yield` leg
        (Gap 2) — the UNCHANGED enrichment, byte-for-byte the old resolver's. No-op when no
        `MarketDataReader` is injected. Computes market cap per name from the as-of adjusted close (the
        SAME series momentum uses) × the name's as-of `shares_outstanding` × FX→GBP, and drops the key
        when any input is missing (NaN-excluded, never a fabricated 0).

        The market-data reads (`adjusted_closes_as_of`, `dividend_yields_as_of`, `fx_to_gbp`) key on the
        T212 ticker form (the bars view's key), so each name's T212 string is derived via the adapter
        (`t212_of`) regardless of whether the request was bare or T212. The reads are batched/coalesced:
        ONE batch close round-trip, ONE batch dividend-yield round-trip, FX once per distinct currency.
        An unresolved name (empty line items, no source) is skipped (nothing to value) and excluded from
        the upstream reads — keyed by the original request ticker in the returned map."""
        if self._market_data is None:
            return resolved
        # The names worth valuing — resolved with at least one fact. Map each to its T212 form for the
        # market-data reads (the bars view / dividend endpoint key on T212).
        valuable_t212: dict[str, str] = {}  # request ticker → T212 form
        for t, tf in resolved.items():
            if tf.source is None and not tf.line_items:
                continue  # unresolved — nothing to value
            valuable_t212[t] = t212_of(t, identity_of(t))

        t212_tickers = list(dict.fromkeys(valuable_t212.values()))  # de-duped, order-preserving

        # Coalesced upstream reads (one round-trip each); FX resolved once per distinct currency. Keyed
        # by the T212 form the market-data service returns.
        dy_by_t212 = await self._market_data.dividend_yields_as_of(t212_tickers, as_of_ms)
        closes_by_t212 = await self._market_data.adjusted_closes_as_of(t212_tickers, as_of_ms)
        fx_by_currency: dict[Optional[str], Optional[float]] = {}
        for t212 in t212_tickers:
            ccy = currency_of(t212)
            if ccy not in fx_by_currency:
                fx_by_currency[ccy] = await self._market_data.fx_to_gbp(ccy)

        enriched: dict[str, TickerFundamentals] = {}
        for ticker, tf in resolved.items():
            if ticker not in valuable_t212:
                enriched[ticker] = tf  # unresolved — pass through untouched
                continue
            t212 = valuable_t212[ticker]
            market_cap = compute_market_cap_gbp(
                closes_by_t212.get(t212),
                tf.line_items.get("shares_outstanding"),
                fx_by_currency.get(currency_of(t212)),
            )
            new_items = apply_pit_market_cap(tf.line_items, market_cap)
            new_items = apply_dividend_yield(new_items, dy_by_t212.get(t212))
            enriched[ticker] = TickerFundamentals(
                line_items=new_items,
                source=tf.source,
                observation_ts=tf.observation_ts,
                knowledge_ts=tf.knowledge_ts,
            )
        return enriched


def _now_ms() -> int:
    """Current wall-clock UTC ms — the knowledge cutoff for a live (asOf-less) read. The lake has no
    `is_superseded` fast lane (that was the Timescale model); 'live' is 'everything knowable as of now',
    so an unbounded live read is `knowledge_ts <= now`."""
    import time

    return int(time.time() * 1000)
