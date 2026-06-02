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
from src.application.validator import Validator, _decision_locked, _quasi_p


def test_quasi_p_mechanism():
    # Real objective far above the permutation null ⇒ low p (real signal).
    assert _quasi_p(10.0, [1.0, 2.0, 3.0]) == pytest.approx(0.25)
    # Real below the null ⇒ p = 1 (indistinguishable from / worse than noise).
    assert _quasi_p(0.0, [1.0, 2.0, 3.0]) == pytest.approx(1.0)
    # Ties count toward the null (≥). 2 of {1,2,3} are ≥ 2 ⇒ (1+2)/(1+3).
    assert _quasi_p(2.0, [1.0, 2.0, 3.0]) == pytest.approx(0.75)
    assert _quasi_p(1.0, []) == 1.0


def test_decision_locked_bounds():
    # n=1000, threshold=0.01. FAIL locks once (1+count)/(1+n) ≥ 0.01 ⇒ 1+count ≥ 10.01 ⇒ count ≥ 10.
    assert _decision_locked(count_ge=10, done=20, n=1000, threshold=0.01) is False   # fail certain
    assert _decision_locked(count_ge=9, done=20, n=1000, threshold=0.01) is None      # just shy ⇒ undetermined
    assert _decision_locked(count_ge=0, done=20, n=1000, threshold=0.01) is None
    # PASS locks only when even all-remaining-exceed stays < threshold ⇒ needs done ≈ n.
    assert _decision_locked(count_ge=0, done=992, n=1000, threshold=0.01) is True      # pass certain (hi=9/1001)
    assert _decision_locked(count_ge=0, done=500, n=1000, threshold=0.01) is None
    # A tiny N can never reach p<0.01 (min p = 1/(1+n) = 1/7), so FAIL locks on the first permutation.
    assert _decision_locked(count_ge=0, done=1, n=6, threshold=0.01) is False


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
        mcpt_early_stop=False,                   # run the full tiny loop so the smoke exercises every step
    )
    # Well-formed: four steps + gates present, and no insufficient_history on a 2y panel.
    for key in ('step1_in_sample_fit', 'step2_in_sample_mcpt', 'step3_walk_forward',
                'step4_walk_forward_mcpt', 'legacy_gates', 'benchmark_overlays', 'data_quality',
                'permutation_seed'):
        assert key in report
    assert len(report['benchmark_overlays']) == 1 and report['benchmark_overlays'][0]['benchmark'] == '^GSPC'
    assert report['engine'] == 'replay_mcpt'
    assert report['universe_size_at_run'] == 6
    assert isinstance(report['passed'], bool)
    assert report['permutation_seed'] == {'engine': 'MT19937', 'base': 0, 'wf_offset': 10000,
                                          'n_in_sample': 6, 'n_wf': 4}

    for step, n in (('step2_in_sample_mcpt', 6), ('step4_walk_forward_mcpt', 4)):
        q = report[step]['quasi_p']
        assert 0.0 < q <= 1.0                    # a valid Monte-Carlo p-value
        assert report[step]['n_permutations'] == n          # full loop ran (early-stop off)
        assert report[step]['early_stopped'] is False
        assert report[step]['n_planned'] == n

    assert _all_floats_finite(report)            # JSON-safe (no NaN/Inf leaks into the doc)


async def _run(prices, bench, start_ms, end_ms, **kw):
    base = dict(strategy_id='factor_rank_v1', start_ms=start_ms, end_ms=end_ms, train_years=0.5,
                n_folds=3, objective_name='profit_factor', benchmark_tickers=['^GSPC'], rebalance_days=7)
    base.update(kw)
    return await Validator().run(prices, {'^GSPC': bench}, **base)


@pytest.mark.asyncio
async def test_seed_reproducible():
    prices, bench, s, e = _panel()
    a = await _run(prices, bench, s, e, mcpt_n_in_sample=6, mcpt_n_wf=4, seed=0, mcpt_early_stop=False)
    b = await _run(prices, bench, s, e, mcpt_n_in_sample=6, mcpt_n_wf=4, seed=0, mcpt_early_stop=False)
    # Same seed ⇒ byte-identical permutation objectives (the "rerun with the same seed" guarantee).
    assert a['step2_in_sample_mcpt']['permutation_objectives'] == \
        b['step2_in_sample_mcpt']['permutation_objectives']
    assert a['step4_walk_forward_mcpt']['permutation_objectives'] == \
        b['step4_walk_forward_mcpt']['permutation_objectives']
    assert a['permutation_seed'] == {'engine': 'MT19937', 'base': 0, 'wf_offset': 10000,
                                     'n_in_sample': 6, 'n_wf': 4}


def test_seed_changes_the_permutation():
    # The seed actually drives the draw — proven at the permutation level (warmup-independent; a
    # tiny-panel objective collapses to 0 because factor_rank's 12-1 momentum needs 273 bars). Same
    # seed ⇒ identical bars; a different seed reshuffles the path.
    from src.application.permutation import align_panel, panel_to_bars, permute_panel
    prices, _b, _s, _e = _panel()
    panel = align_panel(prices)
    t = panel.tickers[0]

    def closes(seed):
        return [bar.close for bar in panel_to_bars(permute_panel(panel, start_index=0, seed=seed))[t]]

    assert closes(0) == closes(0)        # deterministic per seed
    assert closes(0) != closes(7)        # a different seed reshuffles the path


@pytest.mark.asyncio
async def test_early_stop_matches_full_verdict():
    prices, bench, s, e = _panel()
    full = await _run(prices, bench, s, e, mcpt_n_in_sample=6, mcpt_n_wf=4, mcpt_early_stop=False)
    early = await _run(prices, bench, s, e, mcpt_n_in_sample=6, mcpt_n_wf=4, mcpt_early_stop=True)
    # Synthetic noise can't beat its own permutation null ⇒ both FAIL, identical verdict; the
    # early run stops sooner (p<0.01 is unreachable at N=6, so it fails after one permutation).
    for step in ('step2_in_sample_mcpt', 'step4_walk_forward_mcpt'):
        assert full[step]['passed'] == early[step]['passed']
        assert early[step]['n_permutations'] <= full[step]['n_permutations']
    assert early['step2_in_sample_mcpt']['early_stopped'] is True


@pytest.mark.asyncio
async def test_parallel_matches_serial(monkeypatch):
    """The load-bearing determinism guarantee: the process pool returns the *same* permutation
    objectives (in seed order) as the serial path, so the quasi-p is identical."""
    prices, bench, s, e = _panel()
    monkeypatch.setenv('BACKTEST_MIN_PARALLEL', '4')
    monkeypatch.setenv('BACKTEST_MAX_WORKERS', '1')      # ⇒ SerialMap
    serial = await _run(prices, bench, s, e, mcpt_n_in_sample=8, mcpt_n_wf=2, mcpt_early_stop=False)
    monkeypatch.setenv('BACKTEST_MAX_WORKERS', '2')      # ⇒ ProcessPoolMap (8 ≥ 4)
    par = await _run(prices, bench, s, e, mcpt_n_in_sample=8, mcpt_n_wf=2, mcpt_early_stop=False)
    # The pool reassembles by submission index, so the per-seed objectives match the serial path
    # exactly (in order) — the determinism guarantee that keeps the quasi-p identical.
    assert par['step2_in_sample_mcpt']['permutation_objectives'] == \
        pytest.approx(serial['step2_in_sample_mcpt']['permutation_objectives'])
    assert par['step2_in_sample_mcpt']['quasi_p'] == pytest.approx(serial['step2_in_sample_mcpt']['quasi_p'])
