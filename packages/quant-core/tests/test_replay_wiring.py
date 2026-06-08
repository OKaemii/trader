"""build_replay optimiser selection + the fundamentals-snapshot attach (Plan B backtest path)."""
import asyncio

from quant_core.wiring import build_replay, build_warehouse_pit_reader, set_replay_fundamentals
from quant_core.bars.fundamentals_reader import FundamentalsBarsReader, PitFundamentalsBarsReader
from quant_core.strategy.contract import HistoryView
from quant_core.optimise.inverse_vol import InverseVolOptimiser
from quant_core.optimise.long_only import LongOnlyOptimiser


class _StubReader:
    async def history_as_of(self, tickers, as_of_ms, lookback_bars):
        return HistoryView(closes={t: [1.0, 1.1] for t in tickers}, volumes={}, timestamps={})

    async def daily_bars(self, ticker, start_ms, end_ms=None):
        return []


def teardown_function(_fn):
    set_replay_fundamentals(None)   # never leak the snapshot across tests


def test_build_replay_selects_inverse_vol_for_high_velocity():
    set_replay_fundamentals(None)
    assert isinstance(build_replay('high_velocity_v1', bars=_StubReader())._optimiser, InverseVolOptimiser)
    assert isinstance(build_replay('factor_rank_v1', bars=_StubReader())._optimiser, LongOnlyOptimiser)


def test_set_replay_fundamentals_wraps_reader():
    set_replay_fundamentals({'AAPL': {'market_cap_gbp': 1e10}})
    assert isinstance(build_replay('high_velocity_v1', bars=_StubReader())._bars, FundamentalsBarsReader)
    set_replay_fundamentals(None)
    assert not isinstance(build_replay('high_velocity_v1', bars=_StubReader())._bars, FundamentalsBarsReader)


def test_fundamentals_reader_attaches_snapshot_and_passes_bars():
    fr = FundamentalsBarsReader(_StubReader(), {'AAPL': {'market_cap_gbp': 5e9, 'total_equity': 100.0}})
    hv = asyncio.run(fr.history_as_of(['AAPL'], 0, 10))
    assert hv.fundamentals['AAPL']['market_cap_gbp'] == 5e9
    assert hv.closes['AAPL'] == [1.0, 1.1]


# --- Task 15: warehouse PIT reader composition + no double-wrap ------------------------------

def test_build_warehouse_pit_reader_returns_pit_reader():
    """build_warehouse_pit_reader wraps the inner reader with the per-step true-PIT reader over a
    WarehousePitFundamentals (the connection is only stored, never queried at construction, so a
    placeholder con suffices for the wiring assertion — DuckDB is not needed here)."""
    reader = build_warehouse_pit_reader(_StubReader(), con=object())
    assert isinstance(reader, PitFundamentalsBarsReader)
    assert reader.FUNDAMENTALS_DATA_QUALITY == "point_in_time"


def test_build_replay_does_not_double_wrap_a_pit_reader():
    """When the injected reader already attaches fundamentals per-step (the warehouse PIT reader), a
    set static snapshot must NOT stack a FundamentalsBarsReader on top — the true-PIT map wins. The
    _attaches_fundamentals guard keeps build_replay from overriding it with the approximate snapshot."""
    set_replay_fundamentals({'AAPL': {'market_cap_gbp': 1e10}})
    pit_reader = build_warehouse_pit_reader(_StubReader(), con=object())
    built = build_replay('high_velocity_v1', bars=pit_reader)._bars
    # The PIT reader is preserved as-is (not wrapped in a static FundamentalsBarsReader).
    assert built is pit_reader
    assert isinstance(built, PitFundamentalsBarsReader)
    assert not isinstance(built, FundamentalsBarsReader)
