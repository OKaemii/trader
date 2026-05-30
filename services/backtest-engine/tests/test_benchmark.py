"""benchmark_overlay — α/β/IR/excess against a hand calculation."""
import numpy as np
import pytest

from src.application.benchmark import benchmark_overlay


def test_overlay_matches_hand_calc():
    # strategy +10% then flat; benchmark +5% then flat. ppy=1 keeps the IR arithmetic clean.
    s = np.array([0.10, 0.0])
    b = np.array([0.05, 0.0])
    cmp = benchmark_overlay(s, b, benchmark="^GSPC", periods_per_year=1)

    assert cmp.strategy_total_return == pytest.approx(0.10)
    assert cmp.benchmark_total_return == pytest.approx(0.05)
    assert cmp.excess_total_return == pytest.approx(0.05)
    assert cmp.beats_market is True
    # β = cov/var = 0.0025 / 0.00125 = 2.0; α = mean_s − β·mean_b = 0.05 − 2·0.025 = 0.
    assert cmp.beta == pytest.approx(2.0)
    assert cmp.alpha_annual == pytest.approx(0.0)
    # IR = mean(excess)/std(excess)·√ppy = 0.025/0.0353553·1 = 0.70710678.
    assert cmp.information_ratio == pytest.approx(0.70710678, rel=1e-6)
    assert cmp.benchmark == "^GSPC"


def test_overlay_trails_market():
    cmp = benchmark_overlay(np.array([0.0, 0.0]), np.array([0.02, 0.03]), periods_per_year=52)
    assert cmp.beats_market is False
    assert cmp.excess_total_return < 0


def test_overlay_handles_empty():
    cmp = benchmark_overlay(np.array([]), np.array([]))
    assert cmp.periods == 0
    assert cmp.beats_market is False
    assert cmp.beta == 0.0
