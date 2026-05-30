"""Objective functions — math + the finiteness guarantee the quasi-p count depends on."""
import math

import pytest

from src.application.objectives import make_objective, profit_factor, cum_return, ic_mean, make_sharpe
from src.application.replay_pnl import OosPath


def _path(net=None, ic=None):
    return OosPath(net_returns=net or [], ic_series=ic or [])


def test_profit_factor():
    assert profit_factor(_path([0.1, -0.05, 0.2, -0.05])) == pytest.approx(3.0)


def test_profit_factor_no_losses_is_large_but_finite():
    pf = profit_factor(_path([0.1, 0.2]))
    assert math.isfinite(pf) and pf > 1e6     # eps-guarded, never ∞ (would break JSON + counting)


def test_profit_factor_all_losses_is_zero():
    assert profit_factor(_path([-0.1, -0.2])) == 0.0
    assert profit_factor(_path([])) == 0.0


def test_cum_return():
    assert cum_return(_path([0.1, -0.1])) == pytest.approx(1.1 * 0.9 - 1.0)


def test_ic_mean():
    assert ic_mean(_path(ic=[0.1, 0.2, 0.3])) == pytest.approx(0.2)
    assert ic_mean(_path(ic=[])) == 0.0


def test_sharpe_zero_variance_is_zero():
    assert make_sharpe(52)(_path([0.01, 0.01, 0.01])) == 0.0


def test_make_objective_dispatch_and_unknown():
    assert make_objective('profit_factor') is profit_factor
    assert make_objective('cum_return') is cum_return
    assert callable(make_objective('sharpe', 52))
    with pytest.raises(ValueError):
        make_objective('nonsense')
