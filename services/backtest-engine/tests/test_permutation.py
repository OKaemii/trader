"""Masters bar permutation — the invariants MCPT's validity rests on.

If the permutation leaked the future (didn't preserve the last close) or broke the
cross-sectional structure (per-ticker shuffles), the null distribution would be meaningless and
every quasi-p with it. These assertions are the contract.
"""
import numpy as np
import pytest

from quant_core.types import OHLCVBar
from src.application.permutation import align_panel, permute_bars, permute_panel


def _fixture(n_tickers=5, n_bars=252, seed=7):
    """Aligned OHLCV panel with a common market factor (so there is real cross-sectional
    correlation to preserve) and valid bars (high ≥ max(o,c), low ≤ min(o,c))."""
    rng = np.random.default_rng(seed)
    base = 1_700_000_000_000
    ts = [base + i * 86_400_000 for i in range(n_bars)]
    market = rng.normal(0, 0.008, size=n_bars)             # shared factor
    series: dict[str, list[OHLCVBar]] = {}
    for k in range(n_tickers):
        idio = rng.normal(0, 0.006, size=n_bars)
        c2c = 0.7 * market + idio                          # close-to-close log returns
        gap = 0.4 * c2c + rng.normal(0, 0.002, size=n_bars)  # overnight carries the factor too
        close = 100.0 * np.exp(np.cumsum(c2c))
        prev_close = np.concatenate([[100.0], close[:-1]])
        open_ = prev_close * np.exp(gap)
        hi = np.maximum(open_, close) * np.exp(np.abs(rng.normal(0, 0.003, size=n_bars)))
        lo = np.minimum(open_, close) * np.exp(-np.abs(rng.normal(0, 0.003, size=n_bars)))
        series[f'T{k}'] = [
            OHLCVBar(ticker=f'T{k}', timestamp=ts[i], open=float(open_[i]), high=float(hi[i]),
                     low=float(lo[i]), close=float(close[i]), volume=1000.0)
            for i in range(n_bars)
        ]
    return series


def _c2c_returns(bars):
    c = np.array([b.close for b in bars])
    return np.diff(np.log(c))


def _mean_pairwise_corr(series):
    rets = np.array([_c2c_returns(series[t]) for t in sorted(series)])
    cm = np.corrcoef(rets)
    off = cm[~np.eye(len(cm), dtype=bool)]
    return float(off.mean())


def test_determinism():
    src = _fixture()
    a = permute_bars(src, start_index=0, seed=1)
    b = permute_bars(src, start_index=0, seed=1)
    c = permute_bars(src, start_index=0, seed=2)
    assert [bar.close for bar in a['T0']] == [bar.close for bar in b['T0']]
    assert [bar.close for bar in a['T0']] != [bar.close for bar in c['T0']]


def test_first_bar_preserved():
    src = _fixture()
    out = permute_bars(src, start_index=0, seed=3)
    for t in src:
        assert out[t][0].open == pytest.approx(src[t][0].open, rel=1e-9)
        assert out[t][0].close == pytest.approx(src[t][0].close, rel=1e-9)


def test_last_close_preserved():
    # The endpoint holds: Σ(gap)+Σ(rc) is permutation-invariant, so cumulative drift is intact.
    src = _fixture()
    out = permute_bars(src, start_index=0, seed=4)
    for t in src:
        assert out[t][-1].close == pytest.approx(src[t][-1].close, rel=1e-6)


def test_positivity():
    src = _fixture()
    out = permute_bars(src, start_index=0, seed=5)
    for t in src:
        assert all(b.open > 0 and b.high > 0 and b.low > 0 and b.close > 0 for b in out[t])


def test_cross_sectional_correlation_preserved():
    src = _fixture()
    out = permute_bars(src, start_index=0, seed=6)
    assert abs(_mean_pairwise_corr(out) - _mean_pairwise_corr(src)) < 0.1


def test_start_index_keeps_prefix_fixed():
    src = _fixture()
    k = 100
    out = permute_bars(src, start_index=k, seed=8)
    for t in src:
        for i in range(k + 1):   # bars 0..k are the unshuffled (training) region
            assert out[t][i].close == pytest.approx(src[t][i].close, rel=1e-9)


def test_align_panel_drops_short_tickers():
    src = _fixture(n_tickers=3, n_bars=120)
    # A late lister covering < 80% of the richest series must be dropped from the panel.
    src['LATE'] = src['T0'][80:]
    panel = align_panel(src)
    assert 'LATE' not in panel.tickers
    assert set(panel.tickers) == {'T0', 'T1', 'T2'}
