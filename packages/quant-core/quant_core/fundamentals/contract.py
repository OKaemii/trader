"""Fundamentals contract — the canonical line-item vocabulary + the PIT seam, shared by both
the ingestion write-path (which *produces* these keys) and the factor read-path (which *consumes*
them). One definition here so the writer and the reader cannot drift to different spellings.

WHY this lives in quant-core (not strategy-engine):
`LINE_ITEMS`, the `FundamentalsAsOf` Protocol, the source stamps and the market router are read by
BOTH live (strategy-engine) and replay (backtest-engine) and produced by the fundamentals-ingestion
write-path — they are the contract every side agrees on. quant-core is the single source of truth
shared by live + replay, so the contract belongs here and each side imports it. Only the concrete
`YahooFundamentalsAsOf` implementation stays in strategy-engine, because it depends on that service's
`MarketDataClient`; strategy-engine re-exports the names below from its original
`infrastructure/fundamentals_as_of.py` so nothing downstream changes import path.

THE LINE-ITEM CONTRACT:
`LINE_ITEMS` is the snake_case key set the fundamentals factors + the QMJ screen read off
`HistoryView.fundamentals[ticker]`, and the exact set the ingestion-normalize step pivots its
canonical facts into. Keeping the two ends pinned to one tuple is what prevents a writer emitting,
say, `revenue` while the factor reads `total_revenue`. The set is the union of every key the
consumers touch:
  - QualityFactor:  net_income, total_equity, gross_profit, total_revenue, total_debt,
                    earnings_stability
  - ValueFactor:    dividend_yield, net_income, total_equity, market_cap_gbp
  - QMJ screen:     net_income, total_equity, total_debt, current_assets, current_liabilities
  - PIT market cap: shares_outstanding (× as-of adjusted close × FX → market_cap_gbp)
  - balance-sheet identity / investment legs: total_assets, total_liabilities, cash_flow_ops
A field a given source can't supply is simply ABSENT from a name's dict — the factor NaN-excludes a
missing component rather than reading a fabricated 0 (see `strategy/factors.py`). Membership in
`LINE_ITEMS` does NOT make a key mandatory; it pins the *spelling* both ends use when the key exists.

MARKET ROUTING — the T212 ticker suffix selects the jurisdiction's PIT source:
  - `*_US_EQ` → US  (SEC EDGAR)
  - `*l_EQ`   → UK  (Companies House)
A jurisdiction we can't route still works today (the Yahoo snapshot is global); the route selects the
per-jurisdiction PIT warehouse once it exists.

SOURCE STAMP — every provider names its origin via `source_for(ticker)`; persisted alongside each
computed factor in `factor_scores` so a later PIT re-backfill knows which previously-`None` rows it
may upgrade in place (matched by `(ticker, observation_ts)`, guarded by `source`):
  `yahoo-snapshot` (forward-only live) | `pit-edgar` | `pit-companies-house` (the PIT warehouse).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

# Canonical snake_case line items — the single shared vocabulary between the ingestion-normalize
# OUTPUT and the factor/QMJ INPUT. Ordered for readability (income, balance sheet, cash flow,
# market). Both ends import THIS tuple rather than re-listing keys, so they cannot drift.
LINE_ITEMS: tuple[str, ...] = (
    "net_income",
    "total_equity",
    "total_assets",
    "total_liabilities",
    "current_assets",
    "current_liabilities",
    "total_debt",
    "gross_profit",
    "total_revenue",
    "cash_flow_ops",
    "market_cap_gbp",
    "shares_outstanding",
    "dividend_yield",
    "earnings_stability",
)

# Source stamps persisted per factor in `factor_scores` (see module docstring).
SOURCE_YAHOO_SNAPSHOT = "yahoo-snapshot"
SOURCE_PIT_EDGAR = "pit-edgar"
SOURCE_PIT_COMPANIES_HOUSE = "pit-companies-house"

# Jurisdiction routes — selected by the T212 ticker suffix. The PIT warehouse uses these to pick
# SEC EDGAR (US) vs Companies House (UK); the Yahoo snapshot ignores them (global).
MARKET_US = "US"
MARKET_UK = "UK"
MARKET_OTHER = "OTHER"


def market_of(ticker: str) -> str:
    """Route a T212 ticker to its jurisdiction by suffix (the PIT source selector)."""
    if ticker.endswith("_US_EQ"):
        return MARKET_US
    if ticker.endswith("l_EQ"):
        return MARKET_UK
    return MARKET_OTHER


@runtime_checkable
class FundamentalsAsOf(Protocol):
    """Point-in-time fundamentals provider — the seam the host reads to fill
    `HistoryView.fundamentals`.

    Implementations answer `fetch(ticker, as_of_ms)` with the snake_case line-item dict the
    Quality/Value factors read (keys drawn from `LINE_ITEMS`), or `{}` when no fundamentals are
    known for that name as-of that knowledge-time. The Yahoo-snapshot impl (strategy-engine) answers
    ≈`now` only; the PIT warehouse providers answer any past `as_of_ms`.

    The lookups are `async` because every impl reaches an out-of-process source (HTTP today, a
    warehouse query later); `fetch_many` is the per-cycle hot path the host calls to fill the whole
    universe in one round-trip, with `fetch` the single-name convenience over it.
    """

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Line-item dicts keyed by ticker as known at `as_of_ms`; names with none are absent
        (an all-`{}` result is the forward-only "no PIT source" signal)."""
        ...

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Line items for `ticker` as known at knowledge-time `as_of_ms`, or `{}` if none."""
        ...

    def source_for(self, ticker: str) -> str:
        """The `source` stamp persisted alongside each factor this provider feeds."""
        ...
