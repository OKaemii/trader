"""FundamentalsAsOf — the point-in-time (PIT) fundamentals seam (strategy-engine side).

This is the socket the research-factor layer reads through. The host fills
`HistoryView.fundamentals[ticker]` from a `FundamentalsAsOf` provider, so the factor code
(`quant_core.strategy.factors` QualityFactor / ValueFactor) never learns whether the numbers
came from today's forward-only Yahoo snapshot or a point-in-time warehouse — it just consumes a
snake_case line-item dict.

CONTRACT MOVED TO quant-core. The canonical pieces every side agrees on — the snake_case
`LINE_ITEMS` key set, the `FundamentalsAsOf` Protocol, the `SOURCE_*` stamps, and the `MARKET_*` /
`market_of()` router — now live in `quant_core.fundamentals.contract` (read by both live and replay,
and produced by the fundamentals-ingestion write-path; one source of truth so the writer and the
readers cannot drift). They are RE-EXPORTED from this module unchanged, so every existing import
path (`from src.infrastructure.fundamentals_as_of import FundamentalsAsOf, market_of, SOURCE_*,
MARKET_*`) keeps working. Only `YahooFundamentalsAsOf` stays here, because it depends on this
service's `MarketDataClient`.

WHY a seam (and only a Yahoo seam here today):
EODHD Fundamentals is not entitled, so there is no deep historical fundamentals source in THIS
service. The honest consequence is that Quality and the earnings/book leg of Value are
**forward-only**: they can be computed for ≈`now` (the live snapshot) but NOT reconstructed for a
past knowledge-time without look-ahead. Rather than fabricate a historical proxy (which would leak
future information into a backtest), a past `as_of_ms` resolves to an EMPTY dict, and the factors
then degrade to None for that name in that cycle. That is the whole point: never a look-ahead proxy.
The PIT warehouse (the wider epic, served by `fundamentals-api`) is what answers a past `as_of_ms`
honestly via the relocated Protocol; this module's Yahoo impl remains the live fallback.

Return shape — the snake_case line items the factors read off `HistoryView.fundamentals[t]`
(keys drawn from `quant_core.fundamentals.LINE_ITEMS`; QualityFactor: net_income, total_equity,
gross_profit, total_revenue, total_debt, earnings_stability; ValueFactor: dividend_yield,
net_income, total_equity, market_cap_gbp). A field the upstream snapshot doesn't carry is simply
absent (the factor z-scores over the names that have it; a missing component is NaN-excluded, never
a false 0). An empty dict means "no fundamentals for this name/as-of" — the forward-only signal.
"""

from __future__ import annotations

import time

# Re-export the canonical contract from quant-core so existing imports of these names from this
# module keep resolving (back-compat). The single source of truth is quant_core.fundamentals.
from quant_core.fundamentals import (  # noqa: F401  (re-exported for back-compat)
    LINE_ITEMS,
    MARKET_OTHER,
    MARKET_UK,
    MARKET_US,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    SOURCE_YAHOO_SNAPSHOT,
    FundamentalsAsOf,
    market_of,
)

from .market_data_client import MarketDataClient

# How close to `now` an `as_of_ms` must be for the forward-only Yahoo snapshot to answer it.
# A live cycle's as_of is ≈now (sub-second to a few minutes old); a backfill replays dates days
# to years in the past. One trading day of slack comfortably admits the former while rejecting
# the latter — the snapshot describes the present, so a past as_of has no honest answer. This is
# Yahoo-snapshot-specific (the forward-only gate), so it stays here, not in the shared contract.
FORWARD_ONLY_TOLERANCE_MS = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


class YahooFundamentalsAsOf:
    """Forward-only `FundamentalsAsOf` backed by the live Yahoo snapshot.

    The current `company_fundamentals` snapshot (Yahoo `quoteSummary`, monthly TTL) describes
    fundamentals as they stand *today* — there is no as-of dimension. So this impl is honest
    about its one capability and its one limit:
      - an `as_of_ms` within `FORWARD_ONLY_TOLERANCE_MS` of `now` → the live snapshot's line
        items (the factors compute Quality/Value for the current cycle);
      - any older `as_of_ms` → `{}`  (no look-ahead proxy; historical Quality/Value stay None).

    It reuses `MarketDataClient.fetch_fundamentals` (the existing internal Yahoo path) rather
    than re-implementing the call, then remaps to the full field set the factors read.
    """

    def __init__(self, client: MarketDataClient, *, tolerance_ms: int = FORWARD_ONLY_TOLERANCE_MS) -> None:
        self._client = client
        self._tolerance_ms = tolerance_ms

    def _is_now(self, as_of_ms: int) -> bool:
        """True when `as_of_ms` is close enough to the present for the snapshot to answer it.
        A future as_of (clock skew) is also ≈now; only a PAST as_of beyond the tolerance is
        the forward-only refusal."""
        return (_now_ms() - as_of_ms) <= self._tolerance_ms

    def source_for(self, ticker: str) -> str:
        # market_of() routes the PIT source; for the snapshot the source is always Yahoo.
        return SOURCE_YAHOO_SNAPSHOT

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Batch form — the host fills the whole universe in one round-trip per cycle. A past
        `as_of_ms` returns `{}` for ALL names (forward-only); ≈now returns each name's snapshot
        line items. Names with no upstream fundamentals are simply absent from the map."""
        if not tickers or not self._is_now(as_of_ms):
            return {}
        raw = await self._client.fetch_fundamentals(tickers)
        return {t: _to_factor_line_items(d) for t, d in raw.items()}

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name PIT lookup. Forward-only: a past `as_of_ms` returns `{}`."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


def _to_factor_line_items(snapshot: dict[str, float]) -> dict[str, float]:
    """Project a `MarketDataClient.fetch_fundamentals` row onto the snake_case keys the
    Quality/Value factors read off `HistoryView.fundamentals[t]` (a subset of `LINE_ITEMS`).

    `fetch_fundamentals` already returns snake_case (market_cap_gbp, net_income, total_equity,
    total_debt, …). We pass those through and carry the value-only fields (gross_profit,
    total_revenue, earnings_stability, dividend_yield) when the snapshot supplies them. A field
    the snapshot lacks is OMITTED — the factor NaN-excludes a missing component rather than
    reading a fabricated 0 (the existing fetch_fundamentals defaults absent numerics to 0.0,
    which is fine for the QMJ balance-sheet items it was written for but would be a false signal
    for a margin/stability/yield leg, so those are only emitted when actually present)."""
    out: dict[str, float] = {}
    # Balance-sheet / income items QualityFactor + ValueFactor's earnings/book legs read.
    for key in ("market_cap_gbp", "net_income", "total_equity", "total_debt",
                "gross_profit", "total_revenue"):
        if key in snapshot:
            out[key] = float(snapshot[key])
    # Optional legs — only when the snapshot actually carries them (else NaN-excluded, not 0).
    for key in ("earnings_stability", "dividend_yield"):
        val = snapshot.get(key)
        if val is not None:
            out[key] = float(val)
    return out
