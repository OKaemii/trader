"""compute_research_factors — the strategy-independent 4-factor set + percentiles.

Run in CI / a venv with the quant-core deps installed (sandbox has no numpy):
    ./infra/scripts/run-python-tests.sh
"""
import math

from quant_core.research_factors import (
    RESEARCH_FACTORS,
    compute_research_factors,
)
from quant_core.strategy.contract import HistoryView

WINDOW = 6

# Four price series spanning the momentum/vol spectrum (enough closes for the price factors).
CLOSES = {
    "A": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0],   # steady up    → high momentum, low vol
    "B": [10.0, 9.0, 8.0, 7.0, 6.0, 5.0],        # steady down  → low momentum, low vol
    "C": [10.0, 12.0, 9.0, 13.0, 8.0, 14.0],     # choppy up    → high vol
    "D": [10.0, 8.0, 11.0, 7.0, 12.0, 6.0],      # choppy down  → high vol
}

# Fundamentals spanning quality + value, keyed to the SAME four names so every factor shares the
# cross-section. HQ/CHEAP top each axis; JUNK/RICH sit at the bottom.
FUNDS = {
    "A": {"net_income": 30.0, "total_equity": 100.0, "gross_profit": 60.0,
          "total_revenue": 100.0, "total_debt": 20.0, "earnings_stability": 0.9,
          "market_cap_gbp": 100.0, "dividend_yield": 0.06},
    "B": {"net_income": 12.0, "total_equity": 100.0, "gross_profit": 40.0,
          "total_revenue": 100.0, "total_debt": 80.0, "earnings_stability": 0.5,
          "market_cap_gbp": 200.0, "dividend_yield": 0.03},
    "C": {"net_income": 5.0, "total_equity": 100.0, "gross_profit": 25.0,
          "total_revenue": 100.0, "total_debt": 150.0, "earnings_stability": 0.3,
          "market_cap_gbp": 400.0, "dividend_yield": 0.02},
    "D": {"net_income": 2.0, "total_equity": 100.0, "gross_profit": 10.0,
          "total_revenue": 100.0, "total_debt": 260.0, "earnings_stability": 0.1,
          "market_cap_gbp": 800.0, "dividend_yield": 0.01},
}


def _history(closes=None, fundamentals=None) -> HistoryView:
    closes = CLOSES if closes is None else closes
    fundamentals = FUNDS if fundamentals is None else fundamentals
    return HistoryView(
        closes=closes,
        volumes={t: [1.0] * len(c) for t, c in closes.items()},
        timestamps={t: list(range(len(c))) for t, c in closes.items()},
        fundamentals=fundamentals,
    )


def test_every_row_carries_all_four_factors_each_raw_and_pct():
    """Shape contract T9 persists verbatim: every ticker → all four factors, each {raw, pct}."""
    rows = compute_research_factors(_history(), window=WINDOW)
    assert set(rows) == set(CLOSES)
    for row in rows.values():
        assert set(row) == set(RESEARCH_FACTORS)
        for cell in row.values():
            assert set(cell) == {"raw", "pct"}


def test_percentiles_in_range_and_ordered_with_raw():
    """Percentiles sit in [0,100] and rank-agree with the raw z-score within each factor."""
    rows = compute_research_factors(_history(), window=WINDOW)
    for factor in RESEARCH_FACTORS:
        graded = [(rows[t][factor]["raw"], rows[t][factor]["pct"]) for t in rows
                  if rows[t][factor]["raw"] is not None]
        assert graded, f"expected finite values for {factor}"
        for raw, pct in graded:
            assert 0.0 <= pct <= 100.0
        # higher raw ⇒ higher-or-equal percentile (monotone within the cross-section).
        graded.sort(key=lambda rp: rp[0])
        pcts = [pct for _, pct in graded]
        assert pcts == sorted(pcts)


def test_top_and_bottom_percentiles_are_the_cross_section_extremes():
    """The best/worst raw in a factor map to the max/min percentile of that factor."""
    rows = compute_research_factors(_history(), window=WINDOW)
    for factor in RESEARCH_FACTORS:
        cells = [rows[t][factor] for t in rows if rows[t][factor]["raw"] is not None]
        best = max(cells, key=lambda c: c["raw"])
        worst = min(cells, key=lambda c: c["raw"])
        assert best["pct"] == max(c["pct"] for c in cells)
        assert worst["pct"] == min(c["pct"] for c in cells)


def test_momentum_ranks_the_steady_riser_top():
    """A (steady up) tops momentum; B (steady down) bottoms it."""
    rows = compute_research_factors(_history(), window=WINDOW)
    moms = {t: rows[t]["momentum"]["pct"] for t in rows}
    assert moms["A"] == max(moms.values())
    assert moms["B"] == min(moms.values())


def test_quality_and_value_rank_hq_cheap_top():
    """A is both highest-quality and cheapest → top percentile on both fundamentals factors."""
    rows = compute_research_factors(_history(), window=WINDOW)
    quals = {t: rows[t]["quality"]["pct"] for t in rows}
    vals = {t: rows[t]["value"]["pct"] for t in rows}
    assert quals["A"] == max(quals.values())
    assert quals["D"] == min(quals.values())
    assert vals["A"] == max(vals.values())
    assert vals["D"] == min(vals.values())


def test_missing_factor_is_none_not_zero():
    """A name with no fundamentals gets None (NOT 0) for quality+value, keeps its price factors.

    A 0 here would be a real, middling, rankable score — the failure this invariant exists to
    prevent. Its momentum/volatility (which it DOES have) must still be finite.
    """
    funds = {t: FUNDS[t] for t in ("A", "B", "C")}  # D has price history but NO fundamentals
    rows = compute_research_factors(_history(fundamentals=funds), window=WINDOW)
    # The missing values are literally None (identity), never a 0.0 the optimiser could rank on.
    assert rows["D"]["quality"]["raw"] is None
    assert rows["D"]["quality"]["pct"] is None
    assert rows["D"]["value"]["raw"] is None
    assert rows["D"]["value"]["pct"] is None
    # D keeps the price factors it can compute.
    assert rows["D"]["momentum"]["raw"] is not None
    assert rows["D"]["volatility"]["raw"] is not None


def test_zero_denominator_fundamentals_excluded_not_false_zero():
    """A zero/negative-equity name is dropped from quality (None), not scored a false 0."""
    funds = {
        "A": FUNDS["A"], "B": FUNDS["B"], "C": FUNDS["C"],
        "D": {"net_income": 9.0, "total_equity": 0.0, "total_debt": 5.0,
              "market_cap_gbp": 100.0},  # zero equity denominator
    }
    rows = compute_research_factors(_history(fundamentals=funds), window=WINDOW)
    assert rows["D"]["quality"]["raw"] is None
    assert rows["D"]["quality"]["pct"] is None


def test_short_history_name_gets_none_price_factors():
    """A name with too few closes can't have momentum/volatility → None for those factors."""
    closes = {
        "A": CLOSES["A"],
        "B": CLOSES["B"],
        "C": CLOSES["C"],
        "SHORT": [10.0, 11.0],  # < WINDOW closes → excluded from eligible_returns
    }
    funds = {t: FUNDS.get(t, FUNDS["A"]) for t in closes}
    rows = compute_research_factors(_history(closes=closes, fundamentals=funds), window=WINDOW)
    assert rows["SHORT"]["momentum"] == {"raw": None, "pct": None}
    assert rows["SHORT"]["volatility"] == {"raw": None, "pct": None}
    # But its fundamentals factors (it has full funds) are still computed.
    assert rows["SHORT"]["quality"]["raw"] is not None


def test_all_names_missing_a_factor_yields_none_for_that_factor_everywhere():
    """When NO name has fundamentals, every row's quality+value are None — never a crash, never 0.

    Price factors still resolve for all names; the fundamentals factors are uniformly absent.
    """
    rows = compute_research_factors(_history(fundamentals={}), window=WINDOW)
    assert set(rows) == set(CLOSES)  # price factors still place every name
    for t in rows:
        assert rows[t]["quality"] == {"raw": None, "pct": None}
        assert rows[t]["value"] == {"raw": None, "pct": None}
        assert rows[t]["momentum"]["raw"] is not None
        assert rows[t]["volatility"]["raw"] is not None


def test_empty_history_yields_empty_result():
    """No closes and no fundamentals ⇒ no rows (never a crash)."""
    empty = HistoryView(closes={}, volumes={}, timestamps={}, fundamentals={})
    assert compute_research_factors(empty, window=WINDOW) == {}


def test_single_finite_name_percentile_is_midpoint():
    """A factor with exactly one finite name has no dispersion → that name's percentile is 50.

    (The single name's z-score is NaN under the <2-finite guard, so it's actually dropped — this
    pins the boundary: one fundamentals name alone produces NO finite quality cell, never a 0.)
    """
    funds = {"ONLY": FUNDS["A"]}  # one name with fundamentals; the rest have none
    closes = {"ONLY": CLOSES["A"], "A": CLOSES["A"], "B": CLOSES["B"]}
    rows = compute_research_factors(_history(closes=closes, fundamentals=funds), window=WINDOW)
    # A lone fundamentals name can't be z-scored (needs >=2 for dispersion) → None, not a 0.
    assert rows["ONLY"]["quality"] == {"raw": None, "pct": None}


def test_percentile_ties_share_a_value():
    """Two names with an identical raw factor value share the same percentile (symmetric ties)."""
    # Two identical risers (same momentum + vol) plus one faller.
    closes = {
        "X": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0],
        "Y": [10.0, 11.0, 12.0, 13.0, 14.0, 15.0],
        "Z": [15.0, 14.0, 13.0, 12.0, 11.0, 10.0],
    }
    rows = compute_research_factors(_history(closes=closes, fundamentals={}), window=WINDOW)
    assert math.isclose(rows["X"]["momentum"]["pct"], rows["Y"]["momentum"]["pct"], abs_tol=1e-9)


def test_pure_repeatable_live_replay_parity():
    """Same HistoryView ⇒ identical output across calls — the live/replay determinism invariant."""
    hist = _history()
    a = compute_research_factors(hist, window=WINDOW)
    b = compute_research_factors(hist, window=WINDOW)
    assert a == b
