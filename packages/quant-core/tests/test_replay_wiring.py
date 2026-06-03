"""build_replay optimiser selection + the fundamentals-snapshot attach (Plan B backtest path)."""
import asyncio

from quant_core.wiring import build_replay, set_replay_fundamentals
from quant_core.bars.fundamentals_reader import FundamentalsBarsReader
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
