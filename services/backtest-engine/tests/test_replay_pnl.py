"""replay_pnl — the realisation core: asof (no-lookahead), forward returns, turnover cost,
and the IC sign. A planted monotone signal must produce IC ≈ +1; the reversed signal ≈ −1 —
the property a real validator must have and the synthetic placeholder never did."""
from types import SimpleNamespace

import pytest

from src.application.replay_pnl import (
    PriceSeries,
    forward_return,
    realise,
    series_period_returns,
)


def _step(ts, weights, scores):
    return SimpleNamespace(
        observation_ts=ts,
        target_weights=weights,
        output=SimpleNamespace(composite_scores=scores),
    )


def test_priceseries_asof_no_lookahead():
    ps = PriceSeries(ts=[1000, 2000, 3000], close=[1.0, 2.0, 3.0])
    assert ps.asof(999) is None          # before first bar
    assert ps.asof(2500) == 2.0          # last close at/under t
    assert ps.asof(3000) == 3.0          # inclusive
    assert ps.asof(9999) == 3.0          # carries the last known close forward


def test_forward_return():
    ps = PriceSeries(ts=[1000, 3000], close=[100.0, 102.0])
    assert forward_return(ps, 1000, 3000) == pytest.approx(0.02)
    assert forward_return(ps, 999, 3000) is None   # no close known at t0


def test_series_period_returns_aligns_to_bounds():
    ps = PriceSeries(ts=[1000, 2000, 3000], close=[1.0, 2.0, 3.0])
    assert series_period_returns(ps, [(1000, 2000), (2000, 3000)]) == pytest.approx([1.0, 0.5])


def _planted_prices():
    # Five names; forward return is monotone in the score we will assign.
    rets = {"A": 0.05, "B": 0.04, "C": 0.03, "D": 0.02, "E": 0.01}
    return {t: PriceSeries(ts=[1000, 2000], close=[100.0, 100.0 * (1 + r)]) for t, r in rets.items()}


def test_planted_signal_positive_ic_and_costed_net():
    prices = _planted_prices()
    w = {t: 0.2 for t in prices}
    scores = {"A": 5.0, "B": 4.0, "C": 3.0, "D": 2.0, "E": 1.0}   # aligned with returns
    path = realise([_step(1000, w, scores), _step(2000, {}, {})], prices, round_trip_bps=12.0)

    assert path.period_bounds == [(1000, 2000)]
    assert path.gross_returns[0] == pytest.approx(0.03)            # 0.2·Σ rets
    # turnover from flat = Σ|w|/2 = 0.5; cost = 0.5·12bps = 0.0006.
    assert path.net_returns[0] == pytest.approx(0.03 - 0.0006)
    assert path.net_returns[0] < path.gross_returns[0]
    assert path.ic_series == pytest.approx([1.0])                  # perfect rank agreement


def test_reversed_signal_negative_ic():
    prices = _planted_prices()
    w = {t: 0.2 for t in prices}
    scores = {"A": 1.0, "B": 2.0, "C": 3.0, "D": 4.0, "E": 5.0}   # anti-correlated with returns
    path = realise([_step(1000, w, scores), _step(2000, {}, {})], prices, round_trip_bps=12.0)
    assert path.ic_series == pytest.approx([-1.0])


def test_ic_skipped_below_min_names():
    # Only 4 common names < default min_ic_names=5 → no IC recorded (but a return still is).
    prices = {t: PriceSeries(ts=[1000, 2000], close=[100.0, 101.0]) for t in ("A", "B", "C", "D")}
    w = {t: 0.25 for t in prices}
    scores = {t: float(i) for i, t in enumerate(prices)}
    path = realise([_step(1000, w, scores), _step(2000, {}, {})], prices)
    assert path.ic_series == []
    assert len(path.net_returns) == 1
