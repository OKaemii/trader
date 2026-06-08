"""Fundamentals-attaching BarsReader decorators for replay/backtest.

Two readers attach a per-ticker fundamentals map to every `HistoryView` so quality-screening +
fundamentals-factor strategies (high_velocity_v1, factor_rank_v1's Quality/Value/Investment legs) can
run offline. They differ ONLY in *when* the fundamentals are resolved — which is the whole
point-in-time honesty distinction:

  - `FundamentalsBarsReader`     — ONE static snapshot, the SAME at every replay step (current
                                   `company_fundamentals` applied historically). A deliberate
                                   point-in-time-APPROXIMATE shortcut (Yahoo has no as-of
                                   fundamentals); the caller stamps `data_quality.fundamentals=
                                   'point_in_time_approximate'`.
  - `PitFundamentalsBarsReader`  — per-step as-of fetch from the DuckDB warehouse
                                   (`WarehousePitFundamentals.fetch_many(tickers, as_of_ms)` at EACH
                                   `history_as_of`), so replay is TRULY point-in-time: every step sees
                                   only facts knowable at that step's knowledge-time. Covered names
                                   are stamped `data_quality.fundamentals='point_in_time'` (no longer
                                   `_approximate`); uncovered names degrade to `{}` (the provider omits
                                   them) — never a proxy.

`daily_bars` passes straight through in both (fundamentals don't affect the forward-return / IC /
benchmark series). The `data_quality` STAMP each reader advertises is a class constant the caller
reads (`FUNDAMENTALS_DATA_QUALITY`), so the report stamp and the reader can't drift to different
strings.
"""
from __future__ import annotations

import dataclasses
from typing import Optional

from .reader import BarsReader
from ..fundamentals.contract import FundamentalsAsOf
from ..strategy.contract import HistoryView
from ..types import OHLCVBar


class FundamentalsBarsReader:
    """Attaches ONE static fundamentals snapshot (point-in-time-approximate) to every HistoryView."""

    # The data_quality.fundamentals stamp the caller writes for this (approximate) path.
    FUNDAMENTALS_DATA_QUALITY = "point_in_time_approximate"

    def __init__(self, inner: BarsReader, fundamentals: dict[str, dict[str, float]]) -> None:
        self._inner = inner
        self._fundamentals = fundamentals or {}

    async def history_as_of(self, tickers: list[str], as_of_ms: int, lookback_bars: int) -> HistoryView:
        hv = await self._inner.history_as_of(tickers, as_of_ms, lookback_bars)
        return dataclasses.replace(hv, fundamentals=self._fundamentals)

    async def daily_bars(self, ticker: str, start_ms: int, end_ms: Optional[int] = None) -> list[OHLCVBar]:
        return await self._inner.daily_bars(ticker, start_ms, end_ms)


class PitFundamentalsBarsReader:
    """Attaches a TRUE point-in-time fundamentals snapshot, re-resolved as-of at every replay step.

    Wraps an inner `BarsReader` and a `FundamentalsAsOf` provider (in replay,
    `WarehousePitFundamentals` over the DuckDB warehouse). On each `history_as_of` it calls
    `provider.fetch_many(tickers, as_of_ms)` so the attached map carries exactly the facts knowable at
    THAT step's knowledge-time — no static snapshot reused across steps, no look-ahead. The provider
    omits any name with no resolvable instrument or no fact ≤ as_of, so those names arrive `{}` to the
    strategy (`history.fundamentals.get(t, {})`) — the honest forward-only degrade, never a proxy.

    Covered names are point-in-time, so the caller stamps `FUNDAMENTALS_DATA_QUALITY` (=
    `'point_in_time'`, NOT `_approximate`).
    """

    # The data_quality.fundamentals stamp the caller writes for this (true PIT) path.
    FUNDAMENTALS_DATA_QUALITY = "point_in_time"

    def __init__(self, inner: BarsReader, provider: FundamentalsAsOf) -> None:
        self._inner = inner
        self._provider = provider

    async def history_as_of(self, tickers: list[str], as_of_ms: int, lookback_bars: int) -> HistoryView:
        hv = await self._inner.history_as_of(tickers, as_of_ms, lookback_bars)
        # Per-step as-of fetch — the point-in-time distinction from the static reader above.
        fundamentals = await self._provider.fetch_many(list(tickers), as_of_ms)
        return dataclasses.replace(hv, fundamentals=fundamentals or {})

    async def daily_bars(self, ticker: str, start_ms: int, end_ms: Optional[int] = None) -> list[OHLCVBar]:
        return await self._inner.daily_bars(ticker, start_ms, end_ms)
