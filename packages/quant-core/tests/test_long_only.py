"""Golden-vector parity for the long-only optimiser port.

Mirrors services/signal-service/src/__tests__/LongOnlyOptimiser.test.ts case-for-case (those
expectations are verified against the live TS optimiser), plus two hand-computed exact goldens.
Run: pip install -e packages/quant-core[test] && pytest packages/quant-core
"""
import math

from quant_core.optimise.long_only import (
    MAX_WEEKLY_TURNOVER,
    LongOnlyOptimiser,
    solve_long_only,
)
from quant_core.types import StrategyOutput


def _base(scores=None, tickers=None, sectors=None, current=None, top_k=0):
    scores = scores if scores is not None else [0.8, 0.5, 0.3, -0.1]
    tickers = tickers or ['AAPL', 'MSFT', 'GOOG', 'TSLA']
    sectors = sectors or ['Technology', 'Technology', 'Technology', 'Consumer']
    current = current if current is not None else [0, 0, 0, 0]
    return solve_long_only(scores, tickers, sectors, current, top_k)


def test_all_zero_when_no_positive_scores():
    assert all(w == 0 for w in _base(scores=[-1, -0.5, 0, -0.1]))


def test_nonneg_and_sum_le_one():
    r = _base()
    assert sum(r) > 0
    assert sum(r) <= 1 + 1e-9


def test_excludes_negative_scores():
    assert _base()[3] == 0


def test_length_matches():
    assert len(_base()) == 4


def test_golden_base_input():
    # Hand-computed: caps→[.15,.15,.15,0]; Tech .45>.30 → ×.6667 →[.1,.1,.1,0];
    # norm →[1/3,1/3,1/3,0]; turnover .5>.2 → blend .4 →[.13333,.13333,.13333,0].
    r = _base()
    for i in range(3):
        assert math.isclose(r[i], 0.4 / 3, rel_tol=0, abs_tol=1e-9)
    assert r[3] == 0
    assert math.isclose(sum(r), 0.4, abs_tol=1e-9)


def test_golden_single_stock_fully_invested():
    # scores=[0.8], already fully invested → no turnover blend → [1.0].
    r = solve_long_only([0.8], ['AAPL'], ['Technology'], [1.0], 0)
    assert math.isclose(r[0], 1.0, abs_tol=1e-9)


def test_topk_zeroes_outside_top_k():
    scores = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
    tickers = [f'T{i}' for i in range(10)]
    sectors = [f's{i}' for i in range(10)]
    r = solve_long_only(scores, tickers, sectors, [0] * 10, top_k=3)
    assert r[0] > 0 and r[1] > 0 and r[2] > 0
    assert all(r[i] == 0 for i in range(3, 10))


def test_topk_zero_disables_truncation():
    scores = [1.0, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
    r = solve_long_only(scores, [f'T{i}' for i in range(10)], [f's{i}' for i in range(10)], [0] * 10, top_k=0)
    assert all(w > 0 for w in r)


def test_turnover_capped():
    scores = [1, 0.01, 0.01, 0.01]
    current = [0.25, 0.25, 0.25, 0.25]
    r = solve_long_only(scores, ['A', 'B', 'C', 'D'], ['t', 'h', 'f', 'e'], current)
    turnover = sum(abs(w - current[i]) for i, w in enumerate(r)) / 2
    assert turnover <= MAX_WEEKLY_TURNOVER + 1e-9


def test_optimiser_adapter_maps_by_ticker():
    out = StrategyOutput(
        timestamp=1, strategy_id='factor_rank_v1', ticker_universe=['AAPL', 'MSFT', 'GOOG', 'TSLA'],
        composite_scores={'AAPL': 0.8, 'MSFT': 0.5, 'GOOG': 0.3, 'TSLA': -0.1},
        factor_attributions={}, sectors={'AAPL': 'Technology', 'MSFT': 'Technology', 'GOOG': 'Technology', 'TSLA': 'Consumer'},
        covariance_matrix=[], regime_confidence=0.9, top_k=0,
    )
    w = LongOnlyOptimiser().weights(out, current_weights={})
    assert set(w) == {'AAPL', 'MSFT', 'GOOG', 'TSLA'}
    assert w['TSLA'] == 0
    assert math.isclose(sum(w.values()), 0.4, abs_tol=1e-9)
