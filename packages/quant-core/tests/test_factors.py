"""Factor Composite behaviour. Run in CI / a venv with the quant-core deps installed:
    pip install -e packages/quant-core[test] && pytest packages/quant-core
"""
from quant_core.strategy.contract import HistoryView, StrategyParams
from quant_core.strategy.factors import (
    CompositeFactor,
    LowVolFactor,
    MomentumFactor,
    ReversalFactor,
)

WINDOW = 6
CLOSES = {
    "A": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0],   # steady up
    "B": [10.0, 9.0, 8.0, 7.0, 6.0, 5.0],        # steady down
    "C": [10.0, 12.0, 9.0, 13.0, 8.0, 14.0],     # choppy up
    "D": [10.0, 8.0, 11.0, 7.0, 12.0, 6.0],      # choppy down
}


def _history(closes=None) -> HistoryView:
    closes = closes or CLOSES
    return HistoryView(
        closes=closes,
        volumes={t: [1.0] * len(c) for t, c in closes.items()},
        timestamps={t: list(range(len(c))) for t, c in closes.items()},
    )


def test_composite_equal_weight_is_mean():
    """Default (no weights) composite == mean of leaf z-scores (legacy parity)."""
    comp = CompositeFactor([MomentumFactor(), ReversalFactor(), LowVolFactor()])
    p = StrategyParams(values={})
    score = comp.score(_history(), WINDOW, p)
    bd = comp.breakdown(_history(), WINDOW, p)
    assert set(score) == set(CLOSES)
    for t, v in score.items():
        mean = (bd[t]["momentum"] + bd[t]["reversal"] + bd[t]["low_vol"]) / 3.0
        assert abs(v - mean) < 1e-9
        assert abs(bd[t]["composite"] - mean) < 1e-9


def test_composite_weights_from_params():
    """w_momentum=1, others=0 collapses the composite to the momentum leaf."""
    comp = CompositeFactor([MomentumFactor(), ReversalFactor(), LowVolFactor()])
    p = StrategyParams(values={"w_momentum": 1.0, "w_reversal": 0.0, "w_low_vol": 0.0})
    score = comp.score(_history(), WINDOW, p)
    mom = MomentumFactor().score(_history(), WINDOW, p)
    for t, v in score.items():
        assert abs(v - mom[t]) < 1e-9


def test_eligibility_skips_short_history():
    short = {"A": [10.0, 11.0], "B": [10.0, 9.0]}  # < WINDOW closes
    assert MomentumFactor().score(_history(short), WINDOW, StrategyParams(values={})) == {}
