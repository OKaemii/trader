"""FundamentalsAsOf — the point-in-time (PIT) fundamentals seam.

This is the socket the research-factor layer reads through. The host fills
`HistoryView.fundamentals[ticker]` from a `FundamentalsAsOf` provider, so the factor code
(`quant_core.strategy.factors` QualityFactor / ValueFactor) never learns whether the numbers
came from today's forward-only Yahoo snapshot or a future point-in-time warehouse — it just
consumes a snake_case line-item dict.

WHY a seam (and only a seam here):
EODHD Fundamentals is not entitled, so there is no deep historical fundamentals source. The
honest consequence is that Quality and the earnings/book leg of Value are **forward-only**:
they can be computed for ≈`now` (the live snapshot) but NOT reconstructed for a past
knowledge-time without look-ahead. Rather than fabricate a historical proxy (which would leak
future information into a backtest), a past `as_of_ms` resolves to an EMPTY dict, and the
factors then degrade to None for that name in that cycle. That is the whole point: never a
look-ahead proxy.

Return shape — the snake_case line items the factors read off `HistoryView.fundamentals[t]`
(QualityFactor: net_income, total_equity, gross_profit, total_revenue, total_debt,
earnings_stability; ValueFactor: dividend_yield, net_income, total_equity, market_cap_gbp).
A field the upstream snapshot doesn't carry is simply absent (the factor z-scores over the
names that have it; a missing component is NaN-excluded, never a false 0). An empty dict means
"no fundamentals for this name/as-of" — the forward-only signal.

Market routing — the ticker suffix selects the jurisdiction's future PIT source:
  - `*_US_EQ` → US  (future SEC EDGAR)
  - `*l_EQ`   → UK  (future Companies House)
A jurisdiction we can't route still works today (the Yahoo snapshot is global); the route only
matters once the per-jurisdiction PIT warehouse below exists.

source stamp — every provider names its origin via `source_for(ticker)`. Persisted alongside
each computed factor in `factor_scores` so a later PIT re-backfill knows which previously-`None`
rows it may upgrade in place (matched by `(ticker, observation_ts)`, guarded by `source`):
  `yahoo-snapshot` (this impl) | `pit-edgar` | `pit-companies-house` (the future warehouse).

----------------------------------------------------------------------------------------------
FUTURE DROP-IN: EdgarCompaniesHousePitProvider  (separate later epic — OUT OF SCOPE here)
----------------------------------------------------------------------------------------------
A lightweight PIT fundamentals warehouse built from FREE filings slots in behind THIS interface
with no change to factor code, the `factor_scores` schema, endpoints, or UI. Its pipeline:

  1. Download filings   — SEC EDGAR submissions/company-facts (US, XBRL/iXBRL) and Companies
                          House filing history (UK, iXBRL accounts), market-routed by suffix.
  2. Extract financials — parse the line items the factors need out of the (i)XBRL facts.
  3. Normalize metrics  — to the SAME snake_case keys this module returns, FX-normalised to GBP
                          where the factor expects GBP (e.g. market_cap_gbp).
  4. Store filing dates — the KNOWLEDGE time = the filing/acceptance date, not the period end.
                          This is what makes the lookup point-in-time.
  5. PIT as-of lookup   — `fetch(ticker, as_of_ms)` returns the latest filing whose knowledge
                          time <= as_of_ms. Unlike the Yahoo snapshot it answers ANY past
                          as_of (so historical Quality/Value stop being None), and stamps
                          `source = pit-edgar | pit-companies-house`.

Once it lands, re-running the research backfill upgrades the previously-`None` historical rows
in place. Building that warehouse (XBRL/iXBRL parsing depth, UK coverage) is the later epic.
"""

from __future__ import annotations

import time
from typing import Protocol, runtime_checkable

from .market_data_client import MarketDataClient

# Source stamps persisted per factor in `factor_scores` (see module docstring).
SOURCE_YAHOO_SNAPSHOT = "yahoo-snapshot"
SOURCE_PIT_EDGAR = "pit-edgar"
SOURCE_PIT_COMPANIES_HOUSE = "pit-companies-house"

# Jurisdiction routes — selected by the T212 ticker suffix. The future PIT warehouse uses these
# to pick SEC EDGAR (US) vs Companies House (UK); the Yahoo snapshot ignores them (global).
MARKET_US = "US"
MARKET_UK = "UK"
MARKET_OTHER = "OTHER"

# How close to `now` an `as_of_ms` must be for the forward-only Yahoo snapshot to answer it.
# A live cycle's as_of is ≈now (sub-second to a few minutes old); a backfill replays dates days
# to years in the past. One trading day of slack comfortably admits the former while rejecting
# the latter — the snapshot describes the present, so a past as_of has no honest answer.
FORWARD_ONLY_TOLERANCE_MS = 24 * 60 * 60 * 1000


def market_of(ticker: str) -> str:
    """Route a T212 ticker to its jurisdiction by suffix (future PIT source selector)."""
    if ticker.endswith("_US_EQ"):
        return MARKET_US
    if ticker.endswith("l_EQ"):
        return MARKET_UK
    return MARKET_OTHER


def _now_ms() -> int:
    return int(time.time() * 1000)


@runtime_checkable
class FundamentalsAsOf(Protocol):
    """Point-in-time fundamentals provider — the seam the host reads to fill
    `HistoryView.fundamentals`.

    Implementations answer `fetch(ticker, as_of_ms)` with the snake_case line-item dict the
    Quality/Value factors read (see module docstring), or `{}` when no fundamentals are known
    for that name as-of that knowledge-time. The Yahoo-snapshot impl below answers ≈`now` only;
    the future EdgarCompaniesHousePitProvider answers any past `as_of_ms`.
    """

    def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Line items for `ticker` as known at knowledge-time `as_of_ms`, or `{}` if none."""
        ...

    def source_for(self, ticker: str) -> str:
        """The `source` stamp persisted alongside each factor this provider feeds."""
        ...


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
        # market_of() routes the future PIT source; for the snapshot the source is always Yahoo.
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
    Quality/Value factors read off `HistoryView.fundamentals[t]`.

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
