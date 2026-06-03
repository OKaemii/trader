"""FundamentalsBarsReader — a BarsReader decorator that attaches a fundamentals snapshot to every
HistoryView so quality-screening strategies (high_velocity_v1) can run in replay/backtest.

The snapshot is the SAME at every replay step (current `company_fundamentals` applied historically)
— a deliberate point-in-time-APPROXIMATE shortcut (Yahoo gives current fundamentals, not as-of),
stamped `data_quality.fundamentals='point_in_time_approximate'` by the caller. `daily_bars` passes
straight through (fundamentals don't affect forward-return / IC / benchmark series).
"""
from __future__ import annotations

import dataclasses
from typing import Optional

from .reader import BarsReader
from ..strategy.contract import HistoryView
from ..types import OHLCVBar


class FundamentalsBarsReader:
    def __init__(self, inner: BarsReader, fundamentals: dict[str, dict[str, float]]) -> None:
        self._inner = inner
        self._fundamentals = fundamentals or {}

    async def history_as_of(self, tickers: list[str], as_of_ms: int, lookback_bars: int) -> HistoryView:
        hv = await self._inner.history_as_of(tickers, as_of_ms, lookback_bars)
        return dataclasses.replace(hv, fundamentals=self._fundamentals)

    async def daily_bars(self, ticker: str, start_ms: int, end_ms: Optional[int] = None) -> list[OHLCVBar]:
        return await self._inner.daily_bars(ticker, start_ms, end_ms)
