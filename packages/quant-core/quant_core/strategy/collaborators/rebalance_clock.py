"""RebalanceClock — gates a monthly strategy to the first trading session of each calendar month.

Parity-safe: derived purely from the bar-timestamp stream (no calendar dependency, no forward
knowledge), so live emission and backtest replay agree exactly. The rebalance instant is the
first session whose UTC year-month differs from the previous session's.
"""
from __future__ import annotations

from datetime import datetime, timezone


class RebalanceClock:
    name = "rebalance_clock"

    def is_rebalance(self, timestamps_by_ticker: dict[str, list[int]]) -> bool:
        ts = sorted({t for series in timestamps_by_ticker.values() for t in series})
        if len(ts) < 2:
            return False
        a = datetime.fromtimestamp(ts[-1] / 1000, tz=timezone.utc)
        b = datetime.fromtimestamp(ts[-2] / 1000, tz=timezone.utc)
        return (a.year, a.month) != (b.year, b.month)
