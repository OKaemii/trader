"""Factor Composite behaviour. Run in CI / a venv with the quant-core deps installed:
    pip install -e packages/quant-core[test] && pytest packages/quant-core
"""
import math

from quant_core.strategy.contract import HistoryView, StrategyParams
from quant_core.strategy.factors import (
    CompositeFactor,
    Factor,
    InvestmentFactor,
    LowVolFactor,
    MomentumFactor,
    QualityFactor,
    ReversalFactor,
    ValueFactor,
)
from quant_core.strategy.collaborators.trend_filter import TrendFilter

WINDOW = 6
CLOSES = {
    "A": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0],   # steady up
    "B": [10.0, 9.0, 8.0, 7.0, 6.0, 5.0],        # steady down
    "C": [10.0, 12.0, 9.0, 13.0, 8.0, 14.0],     # choppy up
    "D": [10.0, 8.0, 11.0, 7.0, 12.0, 6.0],      # choppy down
}


def _history(closes=None, fundamentals=None) -> HistoryView:
    closes = closes or CLOSES
    return HistoryView(
        closes=closes,
        volumes={t: [1.0] * len(c) for t, c in closes.items()},
        timestamps={t: list(range(len(c))) for t, c in closes.items()},
        fundamentals=fundamentals or {},
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


def test_momentum_skip_excludes_recent_bars():
    # A rises through the formation window then crashes in the last 2 bars; B is flat in the
    # formation window then spikes in the last 2. With skip=2 the late moves are ignored, so A
    # (the formation winner) outranks B; with skip=0 the late spike flips the ranking to B.
    closes = {
        "A": [10.0, 10.0, 10.0, 10.0, 10.0, 11.0, 12.0, 13.0, 11.0, 10.0],
        "B": [10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 10.0, 12.0, 14.0],
    }
    hist = _history(closes)
    with_skip = MomentumFactor().score(hist, 10, StrategyParams(values={"mom_lookback": 4, "mom_skip": 2}))
    assert with_skip["A"] > with_skip["B"]
    no_skip = MomentumFactor().score(hist, 10, StrategyParams(values={"mom_lookback": 4, "mom_skip": 0}))
    assert no_skip["B"] > no_skip["A"]


def test_trend_filter_excludes_downtrend_and_scales_exposure():
    closes = {
        "UP":   [10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0],
        "DOWN": [20.0, 19.0, 18.0, 17.0, 16.0, 15.0, 14.0, 13.0, 12.0, 11.0, 10.0],
    }
    hist = _history(closes)
    held, exposure, tel = TrendFilter().apply(
        {"UP": 1.0, "DOWN": 0.5}, hist,
        StrategyParams(values={"abs_lookback": 5, "breadth_floor": 0.6, "trend_risk_off_mult": 0.0}),
    )
    assert set(held) == {"UP"}        # DOWN dropped (absolute momentum < 0)
    assert tel["breadth"] == 0.5
    assert exposure == 0.0            # breadth 0.5 < floor 0.6 → risk-off scalar


# --- Continuous Quality + Value factors ------------------------------------------------------

_P = StrategyParams(values={})

# Four names spanning the quality spectrum: HQ is profitable, high-margin, low-leverage; JUNK is
# the mirror image; MID/LOW sit between. Earnings stability tracks the same ordering.
QUALITY_FUNDS = {
    "HQ":   {"net_income": 30.0, "total_equity": 100.0, "gross_profit": 60.0,
             "total_revenue": 100.0, "total_debt": 20.0,  "earnings_stability": 0.9},
    "MID":  {"net_income": 12.0, "total_equity": 100.0, "gross_profit": 40.0,
             "total_revenue": 100.0, "total_debt": 80.0,  "earnings_stability": 0.5},
    "LOW":  {"net_income": 5.0,  "total_equity": 100.0, "gross_profit": 25.0,
             "total_revenue": 100.0, "total_debt": 150.0, "earnings_stability": 0.3},
    "JUNK": {"net_income": 2.0,  "total_equity": 100.0, "gross_profit": 10.0,
             "total_revenue": 100.0, "total_debt": 260.0, "earnings_stability": 0.1},
}

# Value: cheap names (high yields, high book-to-market) vs expensive ones.
VALUE_FUNDS = {
    "CHEAP": {"net_income": 20.0, "market_cap_gbp": 100.0, "total_equity": 110.0,
              "dividend_yield": 0.06},
    "FAIR":  {"net_income": 12.0, "market_cap_gbp": 200.0, "total_equity": 130.0,
              "dividend_yield": 0.03},
    "RICH":  {"net_income": 8.0,  "market_cap_gbp": 500.0, "total_equity": 150.0,
              "dividend_yield": 0.01},
}


def test_quality_factor_ranks_profitable_low_leverage_highest():
    """The QMJ-style composite scores the profitable, high-margin, low-debt name highest."""
    score = QualityFactor().score(_history(fundamentals=QUALITY_FUNDS), WINDOW, _P)
    assert set(score) == set(QUALITY_FUNDS)
    assert score["HQ"] > score["MID"] > score["LOW"] > score["JUNK"]


def test_value_factor_ranks_cheap_highest():
    """High earnings/book yields + dividend yield ⇒ the cheap name tops the cross-section."""
    score = ValueFactor().score(_history(fundamentals=VALUE_FUNDS), WINDOW, _P)
    assert set(score) == set(VALUE_FUNDS)
    assert score["CHEAP"] > score["FAIR"] > score["RICH"]


def test_quality_excludes_missing_and_zero_denominator_never_false_zero():
    """A name with no usable fundamentals is dropped, not scored 0 (which would outrank JUNK)."""
    funds = {
        **QUALITY_FUNDS,
        "BLANK": {},                                  # nothing to compute from
        "ZERO_EQ": {"net_income": 9.0, "total_equity": 0.0, "total_debt": 5.0},  # zero denom
        "NEG_EQ": {"net_income": 9.0, "total_equity": -50.0, "total_debt": 5.0}, # negative denom
    }
    score = QualityFactor().score(_history(fundamentals=funds), WINDOW, _P)
    # Excluded entirely — never a 0.0 that the optimiser could rank above a real (negative) JUNK.
    assert "BLANK" not in score
    assert "ZERO_EQ" not in score
    assert "NEG_EQ" not in score
    assert set(score) == set(QUALITY_FUNDS)


def test_quality_partial_components_still_scores():
    """A name missing some components is still scored from the components it does have."""
    funds = {
        "FULL": QUALITY_FUNDS["HQ"],
        "ROE_ONLY": {"net_income": 1.0, "total_equity": 100.0},   # only ROE computable
        "MARGIN_ONLY": {"gross_profit": 90.0, "total_revenue": 100.0},  # only margin
    }
    score = QualityFactor().score(_history(fundamentals=funds), WINDOW, _P)
    assert set(score) == {"FULL", "ROE_ONLY", "MARGIN_ONLY"}
    assert all(math.isfinite(v) for v in score.values())


def test_value_excludes_non_positive_market_cap():
    """Non-positive market cap can't yield a real earnings/book ratio → name excluded."""
    funds = {
        **VALUE_FUNDS,
        "NO_CAP": {"net_income": 10.0, "market_cap_gbp": 0.0, "total_equity": 50.0},
    }
    score = ValueFactor().score(_history(fundamentals=funds), WINDOW, _P)
    assert "NO_CAP" not in score
    assert set(score) == set(VALUE_FUNDS)


def test_fundamentals_factors_empty_when_no_fundamentals():
    """Bars-only HistoryView (fundamentals={}) ⇒ both factors emit nothing, never crash."""
    assert QualityFactor().score(_history(), WINDOW, _P) == {}
    assert ValueFactor().score(_history(), WINDOW, _P) == {}


def test_fundamentals_factors_satisfy_factor_protocol():
    """Both are structural `Factor`s (so they drop into CompositeFactor / breakdown)."""
    assert isinstance(QualityFactor(), Factor)
    assert isinstance(ValueFactor(), Factor)
    assert QualityFactor().name == "quality"
    assert ValueFactor().name == "value"


def test_fundamentals_factors_compose_and_breakdown():
    """QualityFactor + ValueFactor drop into CompositeFactor; breakdown carries both children."""
    funds = {t: {**QUALITY_FUNDS.get(t, {}), **VALUE_FUNDS.get(t, {})}
             for t in set(QUALITY_FUNDS) | set(VALUE_FUNDS)}
    # Give every name both a quality and a value input so they share a common cross-section.
    for t in funds:
        funds[t].setdefault("market_cap_gbp", 200.0)
        funds[t].setdefault("net_income", 10.0)
        funds[t].setdefault("total_equity", 100.0)
        funds[t].setdefault("dividend_yield", 0.02)
    comp = CompositeFactor([QualityFactor(), ValueFactor()])
    bd = comp.breakdown(_history(fundamentals=funds), WINDOW, _P)
    assert bd  # non-empty common set
    for row in bd.values():
        assert set(row) == {"quality", "value", "composite"}
        assert math.isclose(row["composite"], (row["quality"] + row["value"]) / 2.0, abs_tol=1e-9)


def test_fundamentals_factor_score_is_pure_live_replay_parity():
    """Same HistoryView ⇒ identical output across repeated calls (the live/replay invariant:
    both code paths run this one pure `score`, so they can never diverge in shape or value)."""
    hist = _history(fundamentals=QUALITY_FUNDS)
    live = QualityFactor().score(hist, WINDOW, _P)
    replay = QualityFactor().score(hist, WINDOW, _P)
    assert live.keys() == replay.keys()
    for t in live:
        assert live[t] == replay[t]
    vhist = _history(fundamentals=VALUE_FUNDS)
    assert ValueFactor().score(vhist, WINDOW, _P) == ValueFactor().score(vhist, WINDOW, _P)


# --- Investment (asset-growth anomaly) factor ------------------------------------------------
#
# The provider attaches the prior-year balance-sheet value under the `_prev` suffix (the warehouse
# PIT reader's second-latest annual observation ≤ as_of). The factor reads BOTH the current and the
# `_prev` value and z-scores the YoY growth, sign-flipped so CONSERVATIVE (low-growth) names rank
# highest. CONSERVE expands the least, AGGRESSIVE the most.
INVESTMENT_FUNDS = {
    # asset growth +5%, equity growth +4% — the conservative end → scores HIGH.
    "CONSERVE":   {"total_assets": 105.0, "total_assets_prev": 100.0,
                   "total_equity": 104.0, "total_equity_prev": 100.0},
    # asset growth +25%, equity growth +20% — middle of the pack.
    "MODERATE":   {"total_assets": 125.0, "total_assets_prev": 100.0,
                   "total_equity": 120.0, "total_equity_prev": 100.0},
    # asset growth +60%, equity growth +55% — the aggressive end → scores LOW.
    "AGGRESSIVE": {"total_assets": 160.0, "total_assets_prev": 100.0,
                   "total_equity": 155.0, "total_equity_prev": 100.0},
}


def test_investment_factor_ranks_conservative_growth_highest():
    """The asset-growth anomaly: low balance-sheet growth scores highest (sign-flipped)."""
    score = InvestmentFactor().score(_history(fundamentals=INVESTMENT_FUNDS), WINDOW, _P)
    assert set(score) == set(INVESTMENT_FUNDS)
    assert score["CONSERVE"] > score["MODERATE"] > score["AGGRESSIVE"]


def test_investment_factor_growth_computed_from_two_annual_observations():
    """Parity check: the score is driven by (current − prior)/prior of BOTH legs — a name whose two
    observations are equal (zero growth) outranks a name that grew, and a name that SHRANK (negative
    growth) outranks the zero-growth one (most conservative)."""
    funds = {
        "SHRANK": {"total_assets": 90.0, "total_assets_prev": 100.0,    # -10% assets
                   "total_equity": 95.0, "total_equity_prev": 100.0},   # -5% equity
        "FLAT":   {"total_assets": 100.0, "total_assets_prev": 100.0,   # 0%
                   "total_equity": 100.0, "total_equity_prev": 100.0},  # 0%
        "GREW":   {"total_assets": 130.0, "total_assets_prev": 100.0,   # +30%
                   "total_equity": 120.0, "total_equity_prev": 100.0},  # +20%
    }
    score = InvestmentFactor().score(_history(fundamentals=funds), WINDOW, _P)
    assert score["SHRANK"] > score["FLAT"] > score["GREW"]


def test_investment_factor_excludes_missing_or_non_positive_prior_never_false_zero():
    """No prior-year fact (forward-only Yahoo names) or a non-positive prior base → the name is
    EXCLUDED, never scored 0.0 (which the optimiser could rank above a real aggressive grower)."""
    funds = {
        **INVESTMENT_FUNDS,
        "NO_PREV":  {"total_assets": 120.0, "total_equity": 110.0},      # forward-only: no _prev
        "ZERO_PREV": {"total_assets": 120.0, "total_assets_prev": 0.0,   # zero prior base
                      "total_equity": 110.0, "total_equity_prev": 0.0},
        "NEG_PREV": {"total_assets": 120.0, "total_assets_prev": -50.0,  # negative prior base
                     "total_equity": 110.0, "total_equity_prev": -40.0},
    }
    score = InvestmentFactor().score(_history(fundamentals=funds), WINDOW, _P)
    assert "NO_PREV" not in score
    assert "ZERO_PREV" not in score
    assert "NEG_PREV" not in score
    assert set(score) == set(INVESTMENT_FUNDS)


def test_investment_factor_partial_leg_still_scores():
    """A name with only ONE computable growth leg (e.g. assets but no prior equity) is still scored
    from the leg it has — the blend averages the finite components."""
    funds = {
        "BOTH":        INVESTMENT_FUNDS["CONSERVE"],
        "ASSETS_ONLY": {"total_assets": 150.0, "total_assets_prev": 100.0,   # only asset growth
                        "total_equity": 110.0},                              # no prior equity
        "EQUITY_ONLY": {"total_assets": 150.0,                               # no prior assets
                        "total_equity": 105.0, "total_equity_prev": 100.0},  # only equity growth
    }
    score = InvestmentFactor().score(_history(fundamentals=funds), WINDOW, _P)
    assert set(score) == {"BOTH", "ASSETS_ONLY", "EQUITY_ONLY"}
    assert all(math.isfinite(v) for v in score.values())


def test_investment_factor_empty_when_no_fundamentals():
    """Bars-only HistoryView ⇒ emits nothing, never crashes (forward-only degrade)."""
    assert InvestmentFactor().score(_history(), WINDOW, _P) == {}


def test_investment_factor_satisfies_protocol_and_composes():
    """A structural `Factor` named 'investment' that drops into CompositeFactor/breakdown."""
    assert isinstance(InvestmentFactor(), Factor)
    assert InvestmentFactor().name == "investment"
    comp = CompositeFactor([QualityFactor(), InvestmentFactor()])
    funds = {t: {**QUALITY_FUNDS.get(t, {}), **INVESTMENT_FUNDS.get(t, {})}
             for t in set(QUALITY_FUNDS) & set(INVESTMENT_FUNDS)} or {
        # Ensure a shared cross-section with both a quality and an investment input.
        "X": {**QUALITY_FUNDS["HQ"], **INVESTMENT_FUNDS["CONSERVE"]},
        "Y": {**QUALITY_FUNDS["JUNK"], **INVESTMENT_FUNDS["AGGRESSIVE"]},
    }
    bd = comp.breakdown(_history(fundamentals=funds), WINDOW, _P)
    assert bd
    for row in bd.values():
        assert set(row) == {"quality", "investment", "composite"}


def test_investment_factor_is_pure_live_replay_parity():
    """Same HistoryView ⇒ identical output (the live/replay invariant — one pure `score`)."""
    hist = _history(fundamentals=INVESTMENT_FUNDS)
    assert InvestmentFactor().score(hist, WINDOW, _P) == InvestmentFactor().score(hist, WINDOW, _P)
