"""Factor-input computation tests (epic Task 12) — backs /admin/api/fundamentals-pit/factors.

Proves the surfaced legs equal the live `quant_core.strategy.factors` pre-z-score values (the QA
checklist's "factor reference: matches a hand-computed ROE/earnings-yield within tolerance"):
  * earnings_yield / book_to_market on the COMPUTED PIT market cap (Gap 2);
  * roe / gross_margin / leverage with the exact `_safe_ratio` semantics;
  * a missing input → the leg is `null` (the factor NaN-excludes it — never a fabricated 0);
  * a ≤0 denominator (negative equity, zero market cap) collapses the dependent legs to `null`.
"""
from __future__ import annotations

import math

from src.factors import compute_factor_inputs


def test_hand_computed_value_and_quality_legs() -> None:
    li = {
        "net_income": 100.0,
        "total_equity": 500.0,
        "market_cap_gbp": 2000.0,   # the COMPUTED PIT value (price×shares×fx), not a provider scalar
        "gross_profit": 300.0,
        "total_revenue": 1000.0,
        "total_debt": 250.0,
        "dividend_yield": 0.03,
    }
    f = compute_factor_inputs(li)
    # Value legs.
    assert f["earnings_yield"] == 100.0 / 2000.0      # net_income / market_cap_gbp
    assert f["book_to_market"] == 500.0 / 2000.0      # total_equity / market_cap_gbp
    assert f["dividend_yield"] == 0.03                # host-supplied PIT leg
    # Quality legs.
    assert f["roe"] == 100.0 / 500.0                  # net_income / total_equity
    assert f["gross_margin"] == 300.0 / 1000.0        # gross_profit / total_revenue
    assert f["leverage"] == -(250.0 / 500.0)          # -(total_debt / total_equity), sign flipped


def test_missing_market_cap_nulls_value_legs() -> None:
    # No market_cap_gbp (Gap-2 computation dropped it — missing price/shares/FX) → earnings/book null.
    f = compute_factor_inputs({"net_income": 100.0, "total_equity": 500.0})
    assert f["earnings_yield"] is None
    assert f["book_to_market"] is None
    # But ROE (independent of market cap) is still finite.
    assert f["roe"] == 100.0 / 500.0


def test_nonpositive_denominator_collapses_to_null() -> None:
    # Negative equity is a ≤0 DENOMINATOR for ROE + leverage → both null (no honest score from ≤0 equity),
    # exactly as the live `_safe_ratio` guards its denominator.
    f = compute_factor_inputs(
        {"net_income": 100.0, "total_equity": -50.0, "market_cap_gbp": 2000.0, "total_debt": 10.0}
    )
    assert f["roe"] is None       # net_income / total_equity — denominator ≤0
    assert f["leverage"] is None  # -(total_debt / total_equity) — denominator ≤0
    # book_to_market's DENOMINATOR is market_cap_gbp (positive); total_equity is only the NUMERATOR, so a
    # negative equity yields a finite (negative) book-to-market — `_safe_ratio` guards the denominator, not
    # the numerator's sign. This matches the live ValueFactor.
    assert f["book_to_market"] == -50.0 / 2000.0
    # earnings_yield uses the (positive) market cap, so it survives.
    assert f["earnings_yield"] == 100.0 / 2000.0


def test_zero_market_cap_nulls_value_legs() -> None:
    # A ≤0 market_cap_gbp DENOMINATOR nulls earnings_yield + book_to_market (the Value legs that divide by
    # it), while ROE (on equity) survives.
    f = compute_factor_inputs({"net_income": 100.0, "total_equity": 500.0, "market_cap_gbp": 0.0})
    assert f["earnings_yield"] is None
    assert f["book_to_market"] is None
    assert f["roe"] == 100.0 / 500.0


def test_absent_dividend_yield_is_null_not_zero() -> None:
    f = compute_factor_inputs({"net_income": 1.0, "total_equity": 2.0})
    assert f["dividend_yield"] is None   # absent leg → null, never a fabricated 0


def test_raw_drivers_surfaced_for_hand_verification() -> None:
    li = {"net_income": 100.0, "total_equity": 500.0, "market_cap_gbp": 2000.0, "shares_outstanding": 16.0}
    f = compute_factor_inputs(li)
    assert f["net_income"] == 100.0
    assert f["total_equity"] == 500.0
    assert f["market_cap_gbp"] == 2000.0
    assert f["shares_outstanding"] == 16.0


def test_nonfinite_stored_value_treated_as_absent() -> None:
    # A stored NaN must not propagate into a ratio — treated as absent.
    f = compute_factor_inputs({"net_income": float("nan"), "total_equity": 500.0, "market_cap_gbp": 2000.0})
    assert f["roe"] is None
    assert f["earnings_yield"] is None
    assert f["net_income"] is None or math.isnan(f["net_income"]) is False  # surfaced as None


def test_empty_line_items_all_null() -> None:
    f = compute_factor_inputs({})
    for leg in ("earnings_yield", "book_to_market", "dividend_yield", "roe", "gross_margin", "leverage"):
        assert f[leg] is None
