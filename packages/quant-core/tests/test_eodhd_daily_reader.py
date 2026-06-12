"""EodhdDailyBarsReader — pure-parse + symbol-mapping + no-lookahead slicing, no network.

`parse_eod` is a pure function over a recorded EODHD `/eod` payload (the response shape captured
from the live client: a list of `{date, open, high, low, close, adjusted_close, volume}` rows), and
`history_as_of` / `daily_bars` are exercised against a hand-seeded in-memory cache — so this runs
without httpx or a live feed. The fixtures mirror real EODHD `/eod` rows (oldest-first, ISO dates,
split+dividend-adjusted `adjusted_close`).
"""
import pytest

from quant_core.bars.eodhd_daily_reader import (
    EodhdDailyBarsReader,
    parse_eod,
    to_eodhd_symbol,
)
from quant_core.bars.reader import make_bars_reader
from quant_core.types import OHLCVBar


def _ms(date: str) -> int:
    from datetime import datetime, timezone

    return int(datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


# A recorded EODHD `/eod` response (the subset of fields the reader reads), spanning >2 years so the
# "multi-year adjusted series" contract is exercised. The middle 2024 row has a null close → it must
# be skipped exactly as the live `eodRowToDailyBar` skips a non-positive close.
_EOD_FIXTURE = [
    {"date": "2022-01-03", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
     "adjusted_close": 90.0, "volume": 1000},
    {"date": "2023-01-03", "open": 110.0, "high": 111.0, "low": 109.0, "close": 110.0,
     "adjusted_close": 104.5, "volume": 1100},
    {"date": "2024-01-03", "open": 120.0, "high": 121.0, "low": 119.0, "close": None,
     "adjusted_close": 120.0, "volume": 1200},  # null close → skipped
    {"date": "2024-06-03", "open": 130.0, "high": 131.0, "low": 129.0, "close": 130.0,
     "adjusted_close": 130.0, "volume": 1300},
]


def test_parse_eod_multi_year_adjusted_series():
    bars = parse_eod(_EOD_FIXTURE, "AAPL")
    # The null-close row is dropped; the rest span >2 years, oldest-first.
    assert [b.timestamp for b in bars] == [_ms("2022-01-03"), _ms("2023-01-03"), _ms("2024-06-03")]
    # `close` is the *adjusted* (total-return) series; `raw_close` keeps the unadjusted print.
    assert bars[0].close == pytest.approx(90.0)
    assert bars[0].raw_close == pytest.approx(100.0)
    assert bars[0].adjustment_factor == pytest.approx(0.9)
    # O/H/L scaled by the same per-bar factor so the bar stays internally consistent.
    assert bars[0].open == pytest.approx(90.0)   # 100.0 * 0.9
    assert bars[0].high == pytest.approx(90.9)   # 101.0 * 0.9
    assert bars[1].close == pytest.approx(104.5)
    assert bars[1].raw_close == pytest.approx(110.0)
    # The most-recent bar is unadjusted (adjusted == raw), so order-sizing off the latest close is
    # unaffected by the adjustment.
    assert bars[2].close == pytest.approx(130.0)
    assert bars[2].adjustment_factor == pytest.approx(1.0)


def test_parse_eod_pence_killed_at_lse_boundary():
    # An LSE listing quotes in pence; price_scale=0.01 divides it out to GBP at the boundary.
    rows = [
        {"date": "2023-01-03", "open": 1000.0, "high": 1010.0, "low": 990.0, "close": 1000.0,
         "adjusted_close": 1000.0, "volume": 500},
    ]
    bars = parse_eod(rows, "VODl_EQ", price_scale=0.01)
    assert bars[0].close == pytest.approx(10.0)      # 1000 pence → £10.00
    assert bars[0].raw_close == pytest.approx(10.0)
    assert bars[0].open == pytest.approx(10.0)


def test_parse_eod_missing_adjusted_close_falls_back_to_raw():
    # An index has no adjusted_close → close falls back to the raw close, factor 1.0.
    rows = [{"date": "2023-01-03", "open": 4000.0, "high": 4010.0, "low": 3990.0, "close": 4000.0,
             "volume": 0}]
    bars = parse_eod(rows, "^GSPC")
    assert bars[0].close == bars[0].raw_close == pytest.approx(4000.0)
    assert bars[0].adjustment_factor == pytest.approx(1.0)


def test_parse_eod_empty_or_malformed_payload():
    assert parse_eod([], "AAPL") == []
    assert parse_eod([{"date": "", "close": 1.0}], "AAPL") == []          # no date → skipped
    assert parse_eod([{"close": 1.0}], "AAPL") == []                       # missing date → skipped
    assert parse_eod([{"date": "2023-01-03", "close": 0.0}], "AAPL") == [] # non-positive close → skipped


def test_to_eodhd_symbol_mapping_us_and_lse_and_index():
    # Bare US passthrough → `.US`.
    assert to_eodhd_symbol("AAPL") == "AAPL.US"
    # Dotless share class → EODHD's dashed share-class spelling (BRKB → BRK-B). This is an
    # EODHD-symbol-spelling concern, not a corporate rename (the Yahoo reader spells it the same).
    assert to_eodhd_symbol("BRKB") == "BRK-B.US"
    # Corporate rename FB → META (US), taken from the canonical adapter (apply_rename), not a local
    # table — for the bare form AND the T212 form.
    assert to_eodhd_symbol("FB") == "META.US"
    assert to_eodhd_symbol("FB_US_EQ") == "META.US"
    # S&P 500 index caret → the EODHD INDX exchange.
    assert to_eodhd_symbol("^GSPC") == "GSPC.INDX"
    # Benchmark ETF (bare US) → `.US`.
    assert to_eodhd_symbol("SPY") == "SPY.US"
    assert to_eodhd_symbol("XLK") == "XLK.US"
    # T212 US shape → `.US` (via the canonical adapter).
    assert to_eodhd_symbol("AAPL_US_EQ") == "AAPL.US"
    # T212 LSE shape → `.LSE` (via the canonical adapter).
    assert to_eodhd_symbol("VODl_EQ") == "VOD.LSE"
    # Yahoo-style `.L` suffix normalised to `.LSE`.
    assert to_eodhd_symbol("BP.L") == "BP.LSE"
    # An already-EODHD symbol passes through unchanged (incl. a dotted share class).
    assert to_eodhd_symbol("AAPL.US") == "AAPL.US"
    assert to_eodhd_symbol("BRK.B.US") == "BRK.B.US"


@pytest.mark.asyncio
async def test_history_as_of_no_lookahead():
    reader = EodhdDailyBarsReader()
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


@pytest.mark.asyncio
async def test_daily_bars_slices_cache_window():
    reader = EodhdDailyBarsReader()
    reader._cache["AAA"] = parse_eod(_EOD_FIXTURE, "AAA")
    reader._range["AAA"] = (_ms("2022-01-01"), _ms("2024-12-31"))
    # [2023-01-01, 2024-12-31] excludes the 2022 bar; the null-close 2024 row is already gone.
    bars = await reader.daily_bars("AAA", _ms("2023-01-01"), _ms("2024-12-31"))
    assert [b.timestamp for b in bars] == [_ms("2023-01-03"), _ms("2024-06-03")]


def test_factory_builds_eodhd_daily_reader():
    # The validator builds its price panel via make_bars_reader('eodhd_daily') — assert the source
    # is registered and yields the right concrete type (so the validator wiring is unchanged).
    reader = make_bars_reader("eodhd_daily")
    assert isinstance(reader, EodhdDailyBarsReader)
