"""InMemoryBarsReader — per-ticker no-lookahead slicing, driven from an injected dict."""
import pytest

from quant_core.bars.in_memory_reader import InMemoryBarsReader
from quant_core.types import OHLCVBar


def _bars(ticker, closes, start=1000, step=1000):
    return [
        OHLCVBar(ticker=ticker, timestamp=start + i * step, open=c, high=c, low=c, close=float(c), volume=10)
        for i, c in enumerate(closes)
    ]


@pytest.mark.asyncio
async def test_history_as_of_slices_and_truncates():
    reader = InMemoryBarsReader({'AAA': _bars('AAA', [1, 2, 3, 4])})
    hv = await reader.history_as_of(['AAA'], as_of_ms=2500, lookback_bars=10)
    assert hv.closes['AAA'] == [1.0, 2.0]          # ≤ as_of, future excluded
    hv2 = await reader.history_as_of(['AAA'], as_of_ms=4000, lookback_bars=2)
    assert hv2.closes['AAA'] == [3.0, 4.0]          # last `lookback` only


@pytest.mark.asyncio
async def test_daily_bars_range_and_unknown_ticker():
    reader = InMemoryBarsReader({'AAA': _bars('AAA', [1, 2, 3, 4])})
    got = await reader.daily_bars('AAA', start_ms=2000, end_ms=3000)
    assert [b.timestamp for b in got] == [2000, 3000]
    assert await reader.daily_bars('ZZZ', 0) == []  # unknown ticker → empty, no crash
