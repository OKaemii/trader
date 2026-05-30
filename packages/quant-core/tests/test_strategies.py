"""Strategy + factory behaviour. Run in CI / a venv with quant-core deps installed:
    pip install -e packages/quant-core[test] && pytest packages/quant-core
"""
import numpy as np
import pytest

from quant_core.strategy.contract import (
    FeatureVector,
    HistoryView,
    PortfolioState,
    Strategy,
    StrategyParams,
)
from quant_core.strategy.factory import known_strategies, make_strategy
from quant_core.types import StrategyOutput

EMPTY_PORTFOLIO = PortfolioState(current_weights={}, nav=0.0, cash=0.0)
NO_PARAMS = StrategyParams(values={})


def _trending_history(n_tickers: int, n_closes: int) -> HistoryView:
    rng = np.random.default_rng(7)
    closes = {}
    for i in range(n_tickers):
        drift = 0.001 * (i - n_tickers / 2)
        steps = rng.normal(drift, 0.01, size=n_closes)
        closes[f"T{i}"] = list(100.0 * np.exp(np.cumsum(steps)))
    return HistoryView(
        closes=closes,
        volumes={t: [1.0] * len(c) for t, c in closes.items()},
        timestamps={t: list(range(len(c))) for t, c in closes.items()},
    )


def test_factory_known_ids():
    assert known_strategies() == ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1']


def test_factory_unknown_raises():
    with pytest.raises(ValueError):
        make_strategy('does_not_exist')


def test_report_cadence_follows_bar_frequency(monkeypatch):
    # Coverage moved here from the deleted strategy-engine test_strategy_cadence.py.
    monkeypatch.setenv('BAR_FREQUENCY', 'daily')
    assert make_strategy('factor_rank_v1').config.report_cadence == 'per_cycle'
    monkeypatch.setenv('BAR_FREQUENCY', 'intraday')
    assert make_strategy('factor_rank_v1').config.report_cadence == 'hourly'


@pytest.mark.parametrize('sid', ['factor_rank_v1', 'sector_momentum_v1', 'topology_v1'])
def test_strategies_satisfy_protocol(sid):
    s = make_strategy(sid)
    assert isinstance(s, Strategy)
    assert s.config.strategy_id == sid
    assert isinstance(s.parameter_space(), dict)


def test_factor_rank_emits_and_decides():
    s = make_strategy('factor_rank_v1')
    hist = _trending_history(12, 25)
    fv = s.compute_features(hist, as_of_ms=1_700_000_000_000, params=NO_PARAMS)
    assert isinstance(fv, FeatureVector)
    assert set(fv.composite_scores) == set(fv.ticker_universe)
    out = s.decide(fv, EMPTY_PORTFOLIO)
    assert isinstance(out, StrategyOutput)
    assert out.strategy_id == 'factor_rank_v1'
    assert out.top_k == 20
    # composite == mean of the three z-scored leaves (CompositeFactor equal weight)
    for t in fv.ticker_universe:
        a = fv.per_ticker[t]
        assert abs(fv.composite_scores[t] - (a['momentum'] + a['reversal'] + a['low_vol']) / 3.0) < 1e-9


def test_thin_universe_returns_none():
    s = make_strategy('factor_rank_v1')
    hist = _trending_history(3, 25)   # < min_universe_size (5)
    assert s.compute_features(hist, as_of_ms=1, params=NO_PARAMS) is None


def test_topology_carries_extras():
    s = make_strategy('topology_v1')
    hist = _trending_history(12, 40)
    fv = s.compute_features(hist, as_of_ms=1, params=NO_PARAMS)
    assert fv is not None and fv.extras is not None
    assert 'betti_curves' in fv.extras and 'laplacian_residuals' in fv.extras
    out = s.decide(fv, EMPTY_PORTFOLIO)
    assert out.betti_curves is not None
    assert out.laplacian_residuals is not None
