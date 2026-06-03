"""Golden-vector parity for the inverse-vol optimiser. Mirrors signal-service's
InverseVolOptimiser.test.ts case-for-case. Run via the docker python gate or a venv with deps.
"""
import math

from quant_core.optimise.inverse_vol import InverseVolOptimiser, solve_inverse_vol
from quant_core.types import StrategyOutput


def test_lower_vol_gets_higher_weight():
    # vols [0.1, 0.2, 0.4] → inv [10, 5, 2.5] → sum 17.5 → [0.5714.., 0.2857.., 0.1429..]
    w = solve_inverse_vol([0.1, 0.2, 0.4], ['A', 'B', 'C'], [0, 0, 0])
    assert w[0] > w[1] > w[2]
    assert math.isclose(sum(w), 1.0, abs_tol=1e-9)
    assert math.isclose(w[0], 10 / 17.5, abs_tol=1e-9)
    assert math.isclose(w[1], 5 / 17.5, abs_tol=1e-9)
    assert math.isclose(w[2], 2.5 / 17.5, abs_tol=1e-9)


def test_zero_and_nonfinite_vol_excluded():
    w = solve_inverse_vol([0.0, float('inf'), 0.2], ['A', 'B', 'C'], [0, 0, 0])
    assert w[0] == 0 and w[1] == 0
    assert math.isclose(w[2], 1.0, abs_tol=1e-9)


def test_all_zero_when_no_valid_vol():
    assert solve_inverse_vol([0.0, 0.0], ['A', 'B'], [0, 0]) == [0.0, 0.0]


def test_full_rebalance_at_default_budget():
    w = solve_inverse_vol([0.1, 0.1], ['A', 'B'], [1.0, 0.0])      # default budget 1.0
    assert math.isclose(w[0], 0.5, abs_tol=1e-9)
    assert math.isclose(w[1], 0.5, abs_tol=1e-9)


def test_monthly_turnover_blend_throttles():
    w = solve_inverse_vol([0.1, 0.1], ['A', 'B'], [1.0, 0.0], max_turnover=0.1)
    turnover = sum(abs(w[i] - [1.0, 0.0][i]) for i in range(2)) / 2
    assert turnover <= 0.1 + 1e-9


def test_adapter_reads_volatility_from_attributions():
    out = StrategyOutput(
        timestamp=1, strategy_id='high_velocity_v1', ticker_universe=['A', 'B'],
        composite_scores={'A': 1.0, 'B': 1.0},
        factor_attributions={'A': {'volatility': 0.1}, 'B': {'volatility': 0.2}},
        sectors={}, covariance_matrix=[], regime_confidence=1.0, top_k=2, weighting='inverse_vol',
    )
    w = InverseVolOptimiser().weights(out, current_weights={})
    assert w['A'] > w['B']
    assert math.isclose(sum(w.values()), 1.0, abs_tol=1e-9)
