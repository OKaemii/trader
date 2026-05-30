"""YahooDailyBarsReader — pure-parse + symbol-mapping + no-lookahead slicing.

No network: `parse_chart` is a pure function over a fake Yahoo payload, and `history_as_of`
is exercised against a hand-seeded in-memory cache, so this runs without httpx or a live feed.
"""
import pytest

from quant_core.bars.yahoo_daily_reader import (
    YahooDailyBarsReader,
    parse_chart,
    to_yahoo_symbol,
)
from quant_core.types import OHLCVBar


def _payload(currency="USD", *, with_adjclose=True):
    quote = {
        "open":   [10.0, 11.0, 12.0],
        "high":   [10.5, 11.5, 12.5],
        "low":    [9.5, 10.5, 11.5],
        "close":  [10.0, None, 12.0],   # the middle bar has a null close → must be skipped
        "volume": [100, 200, 300],
    }
    indicators = {"quote": [quote]}
    if with_adjclose:
        indicators["adjclose"] = [{"adjclose": [9.0, 9.5, 11.0]}]
    return {
        "chart": {
            "result": [{
                "meta": {"currency": currency},
                "timestamp": [1000, 2000, 3000],   # epoch SECONDS
                "indicators": indicators,
            }],
            "error": None,
        }
    }


def test_parse_chart_uses_adjclose_and_skips_null_close():
    bars = parse_chart(_payload(), "AAPL")
    assert [b.timestamp for b in bars] == [1_000_000, 3_000_000]   # seconds → ms; null row gone
    # close is the *adjusted* (total-return) series; raw_close keeps the unadjusted print.
    assert bars[0].close == pytest.approx(9.0)
    assert bars[0].raw_close == pytest.approx(10.0)
    assert bars[0].adjustment_factor == pytest.approx(0.9)
    # O/H/L scaled by the same per-bar factor so the bar stays internally consistent.
    assert bars[0].open == pytest.approx(9.0)            # 10.0 * 0.9
    assert bars[1].close == pytest.approx(11.0)
    assert bars[1].raw_close == pytest.approx(12.0)


def test_parse_chart_pence_killed_at_boundary():
    # GBp quote of 1000 pence → £10.00 (÷100), adjusted close also scaled.
    p = _payload(currency="GBp")
    p["chart"]["result"][0]["indicators"]["quote"][0]["close"] = [1000.0, 1000.0, 1000.0]
    p["chart"]["result"][0]["indicators"]["adjclose"][0]["adjclose"] = [1000.0, 1000.0, 1000.0]
    bars = parse_chart(p, "VODl_EQ")
    assert all(b.close == pytest.approx(10.0) for b in bars)
    assert all(b.raw_close == pytest.approx(10.0) for b in bars)


def test_parse_chart_index_without_adjclose_falls_back_to_raw():
    bars = parse_chart(_payload(with_adjclose=False), "^GSPC")
    assert bars[0].close == bars[0].raw_close == pytest.approx(10.0)
    assert bars[0].adjustment_factor == pytest.approx(1.0)


def test_parse_chart_empty_or_error_payload():
    assert parse_chart({}, "AAPL") == []
    assert parse_chart({"chart": {"result": None, "error": "x"}}, "AAPL") == []


def test_to_yahoo_symbol_mapping():
    assert to_yahoo_symbol("AAPL") == "AAPL"          # bare US passthrough
    assert to_yahoo_symbol("BRKB") == "BRK-B"         # dotless share class → Yahoo dash
    assert to_yahoo_symbol("FB") == "META"            # legacy rename
    assert to_yahoo_symbol("^GSPC") == "^GSPC"        # index passthrough
    assert to_yahoo_symbol("BP.L") == "BP.L"          # already suffixed passthrough
    assert to_yahoo_symbol("AAPL_US_EQ") == "AAPL"    # T212 US shape
    assert to_yahoo_symbol("VODl_EQ") == "VOD.L"      # T212 LSE shape → .L


@pytest.mark.asyncio
async def test_history_as_of_no_lookahead():
    reader = YahooDailyBarsReader()
    # Seed the cache directly so no network/httpx is touched (the prefetched fast path).
    reader._cache["AAA"] = [
        OHLCVBar(ticker="AAA", timestamp=1000, open=1, high=1, low=1, close=1.0, volume=10),
        OHLCVBar(ticker="AAA", timestamp=2000, open=2, high=2, low=2, close=2.0, volume=20),
        OHLCVBar(ticker="AAA", timestamp=3000, open=3, high=3, low=3, close=3.0, volume=30),
    ]
    reader._range["AAA"] = (0, 10_000)

    # as_of strictly excludes the future bar at ts=3000.
    hv = await reader.history_as_of(["AAA"], as_of_ms=2500, lookback_bars=10)
    assert hv.closes["AAA"] == [1.0, 2.0]

    # lookback truncation keeps only the most recent N at/under as_of.
    hv2 = await reader.history_as_of(["AAA"], as_of_ms=3000, lookback_bars=2)
    assert hv2.closes["AAA"] == [2.0, 3.0]
    assert hv2.timestamps["AAA"] == [2000, 3000]
