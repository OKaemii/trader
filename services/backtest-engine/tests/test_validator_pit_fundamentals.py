"""Validator wiring of the warehouse PIT fundamentals reader (PIT-fundamentals epic Task 15).

Proves the seam, not the SQL (the real-DuckDB SQL is reconciled in the quant-core suite): when a
`pit_fundamentals` provider is supplied for a `high_velocity_v1` run, the validator
  1. wraps the MAIN-PROCESS replay reader with `PitFundamentalsBarsReader`, so the provider's
     `fetch_many` is called per step with that step's as_of (TRUE point-in-time, not one static
     snapshot reused across steps), and
  2. flips the `data_quality` stamp to 'point_in_time' (the reader's class constant — so the report
     stamp and the reader can't drift).
A recording stub `FundamentalsAsOf` stands in for `WarehousePitFundamentals` (no DuckDB needed — the
wiring is what's under test); it holds no connection, so the provider passing through the run is
trivially fine.
"""
import numpy as np
import pytest

from quant_core.bars.fundamentals_reader import PitFundamentalsBarsReader
from quant_core.fundamentals import SOURCE_PIT_EDGAR
from quant_core.types import OHLCVBar
from src.application.validator import Validator


def _panel(n_tickers=6, n_bars=520, seed=11):
    rng = np.random.default_rng(seed)
    base = 1_600_000_000_000
    ts = [base + i * 86_400_000 for i in range(n_bars)]
    market = rng.normal(0.0002, 0.009, size=n_bars)
    series = {}
    for k in range(n_tickers):
        c2c = 0.6 * market + rng.normal(0, 0.007, size=n_bars)
        close = 100.0 * np.exp(np.cumsum(c2c))
        prev = np.concatenate([[100.0], close[:-1]])
        open_ = prev * np.exp(0.3 * c2c)
        hi = np.maximum(open_, close) * (1 + np.abs(rng.normal(0, 0.003, size=n_bars)))
        lo = np.minimum(open_, close) * (1 - np.abs(rng.normal(0, 0.003, size=n_bars)))
        series[f'T{k}_US_EQ'] = [
            OHLCVBar(ticker=f'T{k}_US_EQ', timestamp=ts[i], open=float(open_[i]), high=float(hi[i]),
                     low=float(lo[i]), close=float(close[i]), volume=1000.0)
            for i in range(n_bars)
        ]
    bench = [OHLCVBar(ticker='^GSPC', timestamp=ts[i], open=0.0, high=0.0, low=0.0,
                      close=float(100 * np.exp(market[:i + 1].sum())), volume=0.0)
             for i in range(n_bars)]
    for b in bench:
        b.high = b.low = b.open = b.close
    return series, bench, ts[0], ts[-1]


class _RecordingProvider:
    """A FundamentalsAsOf that records every as_of it is asked for and returns a covered map for the
    panel names — proving the validator calls it per replay step with a real cursor as_of."""

    def __init__(self, tickers):
        self._tickers = list(tickers)
        self.as_ofs = []

    async def fetch_many(self, tickers, as_of_ms):
        self.as_ofs.append(as_of_ms)
        # A complete QMJ-passing line-item set so high_velocity's fail-closed screen can act on it.
        return {
            t: {
                'net_income': 100.0, 'total_equity': 500.0, 'total_debt': 100.0,
                'current_assets': 300.0, 'current_liabilities': 100.0, 'total_revenue': 800.0,
                'gross_profit': 300.0, 'shares_outstanding': 10.0, 'market_cap_gbp': 1_000.0,
            }
            for t in tickers if t in self._tickers
        }

    async def fetch(self, ticker, as_of_ms):
        return (await self.fetch_many([ticker], as_of_ms)).get(ticker, {})

    def source_for(self, ticker):
        return SOURCE_PIT_EDGAR


@pytest.mark.asyncio
async def test_validator_wires_pit_reader_and_flips_stamp():
    prices, bench, start_ms, end_ms = _panel()
    provider = _RecordingProvider(prices.keys())
    report = await Validator().run(
        prices, {'^GSPC': bench},
        strategy_id='high_velocity_v1', start_ms=start_ms, end_ms=end_ms,
        train_years=0.5, n_folds=3, mcpt_n_in_sample=4, mcpt_n_wf=2,
        objective_name='profit_factor', benchmark_tickers=['^GSPC'], rebalance_days=7,
        mcpt_early_stop=False, pit_fundamentals=provider,
    )
    # Stamp flipped to the true-PIT constant (and NOT the approximate one).
    dq = report['data_quality']
    assert PitFundamentalsBarsReader.FUNDAMENTALS_DATA_QUALITY == 'point_in_time'
    assert 'fundamentals=point_in_time' in dq
    assert 'point_in_time_approximate (current company_fundamentals' not in dq
    # The provider was called per replay step with a real cursor as_of (true PIT, not one static
    # snapshot) — the main-process step-1 fit + step-3 walk-forward both drive it.
    assert len(provider.as_ofs) > 0
    assert all(start_ms <= a <= end_ms for a in provider.as_ofs)
    # Distinct as_ofs ⇒ the reader genuinely re-resolved per step (not one reused snapshot).
    assert len(set(provider.as_ofs)) > 1


@pytest.mark.asyncio
async def test_validator_without_pit_keeps_static_stamp():
    """Without a pit_fundamentals provider, high_velocity stays on the static approximate path — the
    stamp is unchanged (regression guard that the new branch is opt-in)."""
    prices, bench, start_ms, end_ms = _panel()
    report = await Validator().run(
        prices, {'^GSPC': bench},
        strategy_id='high_velocity_v1', start_ms=start_ms, end_ms=end_ms,
        train_years=0.5, n_folds=3, mcpt_n_in_sample=4, mcpt_n_wf=2,
        objective_name='profit_factor', benchmark_tickers=['^GSPC'], rebalance_days=7,
        mcpt_early_stop=False,
    )
    assert 'point_in_time_approximate' in report['data_quality']
