"""Validator end-to-end smoke + the quasi-p mechanism.

The quasi-p *mechanism* (real ≫ perms ⇒ low p ⇒ signal; real ≪ perms ⇒ high p ⇒ no edge) is
asserted deterministically and cheaply. The full validator is then run once on ~2y of synthetic
bars with tiny MCPT counts (CI speed) to prove the four steps wire together and emit a
well-formed, finite, JSON-safe report. Statistical power needs the production 1000/200 counts.
"""
import math

import numpy as np
import pytest

from quant_core.types import OHLCVBar
from src.application.validator import Validator, _quasi_p


def test_quasi_p_mechanism():
    # Real objective far above the permutation null ⇒ low p (real signal).
    assert _quasi_p(10.0, [1.0, 2.0, 3.0]) == pytest.approx(0.25)
    # Real below the null ⇒ p = 1 (indistinguishable from / worse than noise).
    assert _quasi_p(0.0, [1.0, 2.0, 3.0]) == pytest.approx(1.0)
    # Ties count toward the null (≥). 2 of {1,2,3} are ≥ 2 ⇒ (1+2)/(1+3).
    assert _quasi_p(2.0, [1.0, 2.0, 3.0]) == pytest.approx(0.75)
    assert _quasi_p(1.0, []) == 1.0


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
        series[f'T{k}'] = [
            OHLCVBar(ticker=f'T{k}', timestamp=ts[i], open=float(open_[i]), high=float(hi[i]),
                     low=float(lo[i]), close=float(close[i]), volume=1000.0)
            for i in range(n_bars)
        ]
    bench = [OHLCVBar(ticker='^GSPC', timestamp=ts[i], open=float(100 * np.exp(market[:i + 1].sum())),
                      high=0.0, low=0.0, close=float(100 * np.exp(market[:i + 1].sum())), volume=0.0)
             for i in range(n_bars)]
    for b in bench:
        b.high = b.low = b.close
    return series, bench, ts[0], ts[-1]


def _all_floats_finite(obj) -> bool:
    if isinstance(obj, float):
        return math.isfinite(obj)
    if isinstance(obj, dict):
        return all(_all_floats_finite(v) for v in obj.values())
    if isinstance(obj, list):
        return all(_all_floats_finite(v) for v in obj)
    return True


@pytest.mark.asyncio
async def test_validator_end_to_end_smoke():
    prices, bench, start_ms, end_ms = _panel()
    # ~1.4y panel: a short (0.5y) burn-in train + 3 OOS folds keeps each fold's OOS window above
    # the 8-period floor while staying fast. mcpt counts are tiny for CI; production is 1000/200.
    report = await Validator().run(
        prices, {'^GSPC': bench},
        strategy_id='factor_rank_v1', start_ms=start_ms, end_ms=end_ms,
        train_years=0.5, n_folds=3, mcpt_n_in_sample=6, mcpt_n_wf=4,
        objective_name='profit_factor', benchmark_tickers=['^GSPC'], rebalance_days=7,
    )
    # Well-formed: four steps + gates present, and no insufficient_history on a 2y panel.
    for key in ('step1_in_sample_fit', 'step2_in_sample_mcpt', 'step3_walk_forward',
                'step4_walk_forward_mcpt', 'legacy_gates', 'benchmark_overlays', 'data_quality'):
        assert key in report
    assert len(report['benchmark_overlays']) == 1 and report['benchmark_overlays'][0]['benchmark'] == '^GSPC'
    assert report['engine'] == 'replay_mcpt'
    assert report['universe_size_at_run'] == 6
    assert isinstance(report['passed'], bool)

    for step in ('step2_in_sample_mcpt', 'step4_walk_forward_mcpt'):
        q = report[step]['quasi_p']
        assert 0.0 < q <= 1.0                    # a valid Monte-Carlo p-value
        assert report[step]['n_permutations'] >= 1

    assert _all_floats_finite(report)            # JSON-safe (no NaN/Inf leaks into the doc)
