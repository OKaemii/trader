"""WarehouseBarsReader — reads bars from the DuckDB/parquet warehouse for offline replay.

Physically separate from live Timescale so backtests can't starve live signal generation.
DuckDB is an optional extra (`quant-core[warehouse]`), imported lazily.

Phase-4 reconciliation note: the exact parquet layout (Hive partitioning, 5m→daily
aggregation, and the known snapshotter glob mismatch — see memory project-timescale-cutover)
is validated against real snapshotter output in Phase 4. This reader is written against the
documented `<root>/bars/**/*.parquet` layout with a `daily` interval column; adjust the glob
+ aggregation there if the snapshot layout differs.
"""
from __future__ import annotations

import os
from typing import Optional

from ..strategy.contract import HistoryView
from ..types import OHLCVBar


class WarehouseBarsReader:
    def __init__(self, warehouse_root: Optional[str] = None, glob: Optional[str] = None) -> None:
        self._root = (warehouse_root or os.getenv("WAREHOUSE_ROOT", "/srv/warehouse")).rstrip("/")
        self._glob = glob or f"{self._root}/bars/**/*.parquet"
        self._con = None

    def _conn(self):
        if self._con is None:
            import duckdb  # optional extra
            self._con = duckdb.connect(database=":memory:")
        return self._con

    async def history_as_of(
        self, tickers: list[str], as_of_ms: int, lookback_bars: int
    ) -> HistoryView:
        rows = self._conn().execute(
            f"""
            SELECT ticker, observation_ts, close, volume
            FROM read_parquet('{self._glob}')
            WHERE ticker = ANY(?) AND observation_ts <= ? AND interval = 'daily'
              AND is_superseded = FALSE
            ORDER BY ticker, observation_ts ASC
            """,
            [tickers, as_of_ms],
        ).fetchall()
        closes: dict[str, list[float]] = {}
        volumes: dict[str, list[float]] = {}
        timestamps: dict[str, list[int]] = {}
        for ticker, ts, close, vol in rows:
            closes.setdefault(ticker, []).append(float(close))
            volumes.setdefault(ticker, []).append(float(vol or 0))
            timestamps.setdefault(ticker, []).append(int(ts))
        # Keep only the most recent `lookback_bars` per ticker.
        for t in list(closes.keys()):
            closes[t] = closes[t][-lookback_bars:]
            volumes[t] = volumes[t][-lookback_bars:]
            timestamps[t] = timestamps[t][-lookback_bars:]
        return HistoryView(closes=closes, volumes=volumes, timestamps=timestamps)

    async def daily_bars(
        self, ticker: str, start_ms: int, end_ms: Optional[int] = None
    ) -> list[OHLCVBar]:
        hi = end_ms if end_ms is not None else 2 ** 63 - 1
        rows = self._conn().execute(
            f"""
            SELECT observation_ts, open, high, low, close, volume
            FROM read_parquet('{self._glob}')
            WHERE ticker = ? AND interval = 'daily' AND is_superseded = FALSE
              AND observation_ts >= ? AND observation_ts <= ?
            ORDER BY observation_ts ASC
            """,
            [ticker, start_ms, hi],
        ).fetchall()
        return [
            OHLCVBar(ticker=ticker, timestamp=int(ts), open=float(o), high=float(h),
                     low=float(lo), close=float(c), volume=float(v or 0))
            for ts, o, h, lo, c, v in rows
        ]
