"""BarsReader abstraction + factory.

The strategy/replay layer reads price history through this Protocol and never knows whether
it is backed by live market-data-service HTTP or the DuckDB warehouse — the BarsReaderFactory
(an Abstract Factory) makes that choice. Concrete readers are wired in later phases:
  - LiveBarsReader (HTTP, asOf-aware)  — Phase 1
  - WarehouseBarsReader (DuckDB)       — Phase 4
The factory lazy-imports them so this contract module has no concrete dependency.
"""
from __future__ import annotations

from typing import Optional, Protocol

from ..strategy.contract import HistoryView
from ..types import OHLCVBar


class BarsReader(Protocol):
    async def history_as_of(
        self, tickers: list[str], as_of_ms: int, lookback_bars: int
    ) -> HistoryView:
        """Oldest-first closes per ticker, strictly <= as_of_ms (no lookahead), at most
        `lookback_bars` per ticker. Drives compute_features in both live and replay."""
        ...

    async def daily_bars(
        self, ticker: str, start_ms: int, end_ms: Optional[int] = None
    ) -> list[OHLCVBar]:
        """Full daily OHLCV series for one ticker over [start, end]. Drives forward-return /
        IC computation and the benchmark overlay in the backtest."""
        ...


def make_bars_reader(source: str, **kwargs) -> BarsReader:
    """source ∈ {'live','warehouse','yahoo_daily'}. Concrete readers are lazy-imported so
    adding a source never forces this module to depend on a concretion.

    'yahoo_daily' is the offline-research path: free, unmetered, dividend-adjusted multi-year
    daily, fully decoupled from the live (metered) TwelveData budget. A 'twelvedata_daily'
    branch can be slotted in here later (e.g. on a paid plan) without touching any consumer."""
    if source == 'live':
        from .live_reader import LiveBarsReader
        return LiveBarsReader(**kwargs)
    if source == 'warehouse':
        from .warehouse_reader import WarehouseBarsReader
        return WarehouseBarsReader(**kwargs)
    if source == 'yahoo_daily':
        from .yahoo_daily_reader import YahooDailyBarsReader
        return YahooDailyBarsReader(**kwargs)
    if source == 'in_memory':
        from .in_memory_reader import InMemoryBarsReader
        return InMemoryBarsReader(**kwargs)
    raise ValueError(
        f"unknown bars source: {source!r} "
        f"(known: 'live', 'warehouse', 'yahoo_daily', 'in_memory')"
    )
