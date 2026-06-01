"""Range-ladder mapping for the live bars reader.

Regression guard for the momentum-cap bug: the old ladder mapped trading-bar lookbacks 1:1
to calendar-day range keys, so 180 calendar days only covered ~126 trading bars and momentum
was silently capped at ~6 months. `_range_for` now converts bars→calendar days (×1.5) and can
reach the long keys (1y/2y/5y/max) backed by the persisted daily series.
"""
from quant_core.bars.live_reader import _range_for


def test_short_lookbacks_use_short_keys():
    assert _range_for(1) == "30d"
    assert _range_for(20) == "60d"      # 20*1.5+5 = 35 → 60d


def test_twelve_one_momentum_reaches_two_years():
    # 12-1 momentum = 252 lookback + 21 skip = 273 trading bars.
    # 273*1.5+5 = 414 calendar days → 1y (365) is insufficient, needs 2y.
    assert _range_for(273) == "2y"


def test_six_month_momentum_needs_one_year_key():
    # ~126 trading bars → 126*1.5+5 = 194 calendar days → 1y (180d would under-cover).
    assert _range_for(126) == "1y"


def test_caps_at_max():
    assert _range_for(5000) == "max"
