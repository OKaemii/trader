"""InMemoryBarsReader — a BarsReader backed by an injected dict of OHLCV series, no I/O.

This is the workhorse for the permutation validator (Phase 5): a *permuted* bar set is just a
new dict[ticker, list[OHLCVBar]], wrapped here and handed to the same `Replay` the live and
backtest paths use — so MCPT exercises the real strategy code over surrogate price paths with
zero special-casing. It is also a clean test double (it replaces ad-hoc fakes in the suite).

Lock-free and synchronous under the async surface: every method reads an in-memory list, so it
is safe to drive from a worker thread's own event loop (the validator runs off the request
loop) without the cross-loop hazards an httpx/semaphore-backed reader would carry.
"""
from __future__ import annotations

from typing import Optional

from ..strategy.contract import HistoryView
from ..types import OHLCVBar


class InMemoryBarsReader:
    def __init__(self, series: dict[str, list[OHLCVBar]]) -> None:
        # Store each ticker's series oldest-first; copy the lists so later permutation runs that
        # build a fresh reader never alias a caller's data.
        self._series: dict[str, list[OHLCVBar]] = {
            t: sorted(bars, key=lambda b: b.timestamp) for t, bars in series.items()
        }

    async def history_as_of(
        self, tickers: list[str], as_of_ms: int, lookback_bars: int
    ) -> HistoryView:
        closes: dict[str, list[float]] = {}
        volumes: dict[str, list[float]] = {}
        timestamps: dict[str, list[int]] = {}
        for t in tickers:
            series = self._series.get(t)
            if not series:
                continue
            window = [b for b in series if b.timestamp <= as_of_ms][-lookback_bars:]
            if not window:
                continue
            closes[t] = [b.close for b in window]
            volumes[t] = [b.volume for b in window]
            timestamps[t] = [b.timestamp for b in window]
        return HistoryView(closes=closes, volumes=volumes, timestamps=timestamps)

    async def daily_bars(
        self, ticker: str, start_ms: int, end_ms: Optional[int] = None
    ) -> list[OHLCVBar]:
        series = self._series.get(ticker, [])
        return [
            b for b in series
            if b.timestamp >= start_ms and (end_ms is None or b.timestamp <= end_ms)
        ]
