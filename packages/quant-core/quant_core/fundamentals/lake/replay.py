"""LakePitFundamentals — the REPLAY point-in-time fundamentals source, read straight from the lake.

This is the offline twin of the lake-backed `fundamentals-api` resolver: the SAME bi-temporal as-of
read (the lake store's `knowledge_ts <= as_of` filter), the SAME 14-key contract pivot
(`lake.contract.pit_line_items`), and the SAME `price × shares × fx` market-cap identity, but run
DIRECTLY over the per-CIK Parquet lake (and the snapshotted bars view for the price leg) — never the
live HTTP/Redis path. quant-core is the single source of truth shared by live and replay, so the seam
contract (`FundamentalsAsOf`, `LINE_ITEMS`, the source stamp) is identical; only the STORE differs.

WHY THIS REPLACES `WarehousePitFundamentals` FOR REPLAY (plan Thread B §7, Task 12). The DuckDB
*warehouse* `fundamentals` view (a snapshot of the Timescale fundamentals hypertables) is retired as
the backtest fundamentals source — the lake is now the single PIT fundamentals store, so replay reads
the lake just like the live read-API. The warehouse-snapshotter no longer copies the fundamentals
tables (only `bars` stays in the warehouse). This reader keeps the per-step as-of contract
`PitFundamentalsBarsReader` wraps (`fetch_many(tickers, as_of_ms)` at EVERY replay step) — only the
fundamentals source moved from the warehouse view to the lake.

NO-LOOK-AHEAD (the hard constraint). The look-ahead guard is the lake store's `knowledge_ts <= ?`
clause IN SQL (`Store.pit_series` / `metric_series`), exactly as in the live read-API — a fact from a
filing made knowable after `as_of` is never returned because the database never hands it to us. There
is no app-layer date filter a refactor could drop. `earnings_stability` is computed off the same as-of
annual axis. The store itself degrades a cold/empty lake to `[]` per CIK, so this reader degrades a
cold lake to `{}` per name (the forward-only contract) without crashing.

TICKER → IDENTITY AT THE BOUNDARY. Replay still speaks the Trading212 ticker form (`AAPL_US_EQ`,
`SHELl_EQ`) — the panel keys, the constituent rows. The lake contract speaks `TickerIdentity`
(`{symbol, market}`), so this reader converts at the edge via the canonical
`Trading212TickerAdapter.from_t212` (the ONLY suffix parser) + `apply_rename` (market-aware FB→META),
then calls `pit_line_items`. A ticker that is not a recognised US/LSE equity (an index like `^GSPC`,
a malformed string) is treated as uncovered → absent from the map (never crashes the step).

MARKET CAP (Gap 2, the price×shares×fx identity, off the snapshotted BARS view). `market_cap_gbp` is
COMPUTED point-in-time — never a provider scalar — as `adjusted_close(as_of) × shares_outstanding(
as_of) × fx_to_gbp`, the SAME approach `WarehousePitFundamentals` used: the price is the latest daily
bar at/<= as_of from the SAME warehouse `bars` view momentum reads (bars stay in the warehouse — only
the fundamentals snapshot was dropped), `shares_outstanding` is the as-of dei cover-page fact the lake
contract supplies, and `fx_to_gbp` is injected. It is DROPPED (key absent) when any input is missing —
the factor NaN-excludes it, never a fabricated 0.

THE USD-MARKET-CAP FX-SERIES GAP IS UNCHANGED (carried forward, NOT fixed here — plan §7 / the
Task-13 follow-up). `fx_to_gbp` is a caller-supplied `currency -> Optional[rate]` callable. The
default resolves GBP → 1.0 (LSE closes are pence-killed to GBP at the market-data boundary, so a
GBP-native name's market cap is fully computable in replay) and every other currency → None (market
cap absent until the backtest host injects a historical FX series). So a USD name's `market_cap_gbp`
is dropped in replay under the default — the same documented limitation the warehouse path carried;
this task does not wire the historical GBP/USD series (that remains a follow-up).

THE BARS READ IS INJECTED, not done here. quant-core's lake package has no warehouse connection (the
bars live in the separate `/srv/warehouse` snapshot, read by backtest-engine's `WarehouseReader`). So
the price leg is a caller-supplied `bars_close_as_of(t212_ticker, as_of_ms) -> Optional[float]`
callable, keeping this reader pure + unit-testable with no warehouse. The default returns None ⇒ every
name's market cap is dropped (the honest no-op landing for a unit test with no bars); the backtest host
injects a closure over its warehouse bars connection (`main.py`). The bars view is keyed by the T212
ticker, so the callable is handed the ORIGINAL t212 string (post-rename), not the bare symbol.

pyarrow + duckdb are reached only transitively through `store` (the `quant-core[lake]` extra); this
module itself is pure stdlib + the contract/adapter helpers.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from quant_core.fundamentals.contract import (
    MARKET_UK,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    market_of,
)
from quant_core.fundamentals.lake.contract import pit_line_items
from quant_core.fundamentals.warehouse import _compute_market_cap_gbp, _default_fx_to_gbp
from quant_core.ticker_identity import TickerIdentity, Trading212TickerAdapter

log = logging.getLogger("quant_core.fundamentals.lake.replay")

# The market-cap legs we OWN the computation of (price × shares × fx) — overrides any stored value.
# `_compute_market_cap_gbp` / `_default_fx_to_gbp` are IMPORTED (not re-implemented) from warehouse.py
# so the lake replay path and the warehouse replay path share ONE arithmetic identity and ONE default
# FX policy (GBP-identity, else None — the live `fundamentals-api` semantics) and cannot drift.
_MARKET_CAP_KEY = "market_cap_gbp"
_SHARES_KEY = "shares_outstanding"

_ADAPTER = Trading212TickerAdapter()


class LakePitFundamentals:
    """`FundamentalsAsOf` over the PIT fundamentals lake — the replay PIT source (plan Thread B §7).

    Implements the `FundamentalsAsOf` Protocol (`fetch_many` / `fetch` / `source_for`) so it drops
    into the SAME seam the live providers and the warehouse replay provider use; replay calls
    `fetch_many(tickers, as_of_ms)` at each step (via `PitFundamentalsBarsReader`). Holds a lake
    `Store` (the per-CIK Parquet read engine) for line items; the market-cap price leg + the FX rate
    are injected callables so the reader is pure and the warehouse connection stays in the host.

    Injection points keep it pure + deps-light:
      - `bars_close_as_of(t212_ticker, as_of_ms) -> Optional[float]` — the latest daily adjusted close
        at/<= as_of from the warehouse bars view (default None ⇒ market cap dropped for every name).
        Handed the T212 ticker (post-rename), since the bars view keys on the T212 form.
      - `fx_to_gbp(currency) -> Optional[float]` — GBP-per-1-unit multiplier (default: GBP identity,
        else None — the documented USD-FX-series gap).
    """

    def __init__(
        self,
        store,
        *,
        bars_close_as_of: Optional[Callable[[str, int], Optional[float]]] = None,
        fx_to_gbp: Optional[Callable[[Optional[str]], Optional[float]]] = None,
    ) -> None:
        self._store = store
        self._bars_close = bars_close_as_of or (lambda _ticker, _as_of: None)
        self._fx = fx_to_gbp or _default_fx_to_gbp

    def source_for(self, ticker: str) -> str:
        """The PIT `source` stamp a covered name carries, by jurisdiction — mirror the live/warehouse
        `source_for`: UK → Companies House, else US EDGAR. A non-US name is fail-closed `{}` in the
        lake, but the stamp helper stays jurisdiction-consistent with the rest of the platform."""
        return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name as-of line items, or `{}` if uncovered / non-US / no fact ≤ as_of."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """As-of line-item dicts keyed by the ORIGINAL ticker (knowledge_ts ≤ as_of). Names that do not
        resolve to a US identity, or whose lake read is empty, are ABSENT from the map (the
        forward-only degrade — the caller's reader leaves them `{}`, never a proxy). The computed PIT
        market cap is added when price+shares+fx are all available; otherwise the key is dropped."""
        out: dict[str, dict[str, float]] = {}
        for ticker in tickers:
            ident = self._identity_of(ticker)
            if ident is None:
                continue  # not a US/LSE equity form (index, malformed) → uncovered
            line_items, _source, _obs, _kts = pit_line_items(self._store, ident, as_of_ms)
            if not line_items:
                continue  # non-US (fail-closed), cold lake, unknown CIK, or nothing knowable as-of
            self._apply_market_cap(ticker, ident, line_items, as_of_ms)
            out[ticker] = line_items
        return out

    # --- internals -------------------------------------------------------------------------------

    def _identity_of(self, ticker: str) -> Optional[TickerIdentity]:
        """Parse a T212 ticker to its canonical (rename-applied) identity, or None when it is not a
        recognised US/LSE equity. The adapter is the ONLY suffix parser; `apply_rename` maps a legacy
        symbol (FB→META, market-aware) so the lake resolves the surviving CIK. `from_t212` rejects any
        non-US/LSE form (an index like `^GSPC`, a CFD, a malformed string) with a ValueError, which we
        turn into None — so a replay step carrying a benchmark ticker is treated as uncovered, never a
        crash."""
        try:
            ident = _ADAPTER.from_t212(ticker)
        except ValueError:
            return None
        return _ADAPTER.apply_rename(ident)

    def _apply_market_cap(
        self, ticker: str, ident: TickerIdentity, line_items: dict[str, float], as_of_ms: int
    ) -> None:
        """Compute PIT market cap (price × shares × fx) off the injected bars read and OVERRIDE any
        stored scalar; DROP the key when any input is missing (never a fabricated 0). Mirrors
        `WarehousePitFundamentals._apply_market_cap` — same short-circuit, same identity, same FX
        policy — only the price source (injected bars callable) and the currency source (the adapter,
        since we already hold the identity) differ."""
        # Short-circuit before the bars read + FX lookup: no shares ⇒ no honest market cap, so skip
        # the per-name bars query on the replay hot path (per step × per name) and drop any stale
        # scalar. shares is the cheapest gate (already in hand from the pivot).
        shares = line_items.get(_SHARES_KEY)
        if shares is None:
            line_items.pop(_MARKET_CAP_KEY, None)
            return
        close = self._bars_close(ticker, as_of_ms)
        fx_rate = self._fx(_ADAPTER.currency_of(ident))
        cap = _compute_market_cap_gbp(close, shares, fx_rate)
        if cap is None:
            line_items.pop(_MARKET_CAP_KEY, None)
        else:
            line_items[_MARKET_CAP_KEY] = cap
