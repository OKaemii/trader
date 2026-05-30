"""regime_label — soft RegimeState → one discrete bucket for the regime breakdown."""
from src.application.regime import RegimeState, regime_label


def _state(p_trending=0.5, p_high_vol=0.5, p_crisis=0.0):
    return RegimeState(p_trending=p_trending, p_high_vol=p_high_vol, p_expanding=0.3, p_crisis=p_crisis)


def test_crisis_dominates():
    assert regime_label(_state(p_trending=0.9, p_high_vol=0.9, p_crisis=0.6)) == 'crisis'


def test_bull_high_vol():
    assert regime_label(_state(p_trending=0.7, p_high_vol=0.8, p_crisis=0.1)) == 'bull_high_vol'


def test_bear_low_vol():
    assert regime_label(_state(p_trending=0.2, p_high_vol=0.1, p_crisis=0.0)) == 'bear_low_vol'


def test_bull_low_vol_boundary():
    # Exactly at the thresholds: >0.5 is bull/high — so 0.5 falls to bear/low.
    assert regime_label(_state(p_trending=0.5, p_high_vol=0.5)) == 'bear_low_vol'
