from dataclasses import dataclass
from typing import Iterator


@dataclass
class MarketEvent:
    timestamp: int    # UTC ms
    bars: list[dict]  # OHLCVBar dicts for all tickers at this step


class EventDrivenReplay:
    """
    Replays historical OHLCV in strict chronological order.
    Features are computed ONLY from data available at event.timestamp — no lookahead by construction.
    """

    def __init__(self, bars_cursor, bar_interval_ms: int):
        self._cursor = bars_cursor
        self._interval = bar_interval_ms

    def __iter__(self) -> Iterator[MarketEvent]:
        bucket: dict[int, list] = {}
        for bar in self._cursor:
            ts = int(bar['timestamp'].timestamp() * 1000)
            bucket.setdefault(ts, []).append(bar)
        for ts in sorted(bucket.keys()):
            yield MarketEvent(timestamp=ts, bars=bucket[ts])
