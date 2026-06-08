"""Per-name value/quality factor INPUTS from the PIT line items — backs `/admin/api/fundamentals-pit/factors`.

Epic Task 12 surfaces the computed factor inputs the Value/Quality factors z-score, so an operator/QA can
read the point-in-time legs for a universe at an `as_of` (the QA checklist's "factor reference: matches a
hand-computed ROE/earnings-yield within tolerance"). This is the READ-side computation of the SAME ratios
`quant_core.strategy.factors` builds — kept here in pure Python (the deps-clean gate has no numpy and this
service does not depend on it) with EXACTLY the `_safe_ratio` semantics so the numbers match the live
factor:

  Value legs   (ValueFactor):    earnings_yield = net_income  / market_cap_gbp
                                  book_to_market = total_equity / market_cap_gbp
                                  dividend_yield = dividend_yield               (host-supplied PIT leg)
  Quality legs (QualityFactor):  roe          = net_income  / total_equity
                                  gross_margin = gross_profit / total_revenue
                                  leverage     = -(total_debt / total_equity)   (sign flipped: less debt scores higher)

`_safe_ratio` semantics (mirrored from `quant_core/strategy/factors.py`): a denominator that is
missing/non-finite/non-positive, OR a missing/non-finite numerator, yields None (the live factor's NaN —
which the z-score step DROPS, never a fabricated 0). market_cap_gbp here is already the computed PIT value
(price×shares×fx, Gap 2), so earnings_yield/book_to_market are point-in-time and on the same adjusted price
basis as momentum. None for an absent leg flows to JSON `null` — the read surface never invents a 0.
"""
from __future__ import annotations

import math
from typing import Optional


def _safe_ratio(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    """numerator / denominator, or None when the denominator is missing/non-finite/non-positive or the
    numerator is missing/non-finite. PURE mirror of `quant_core.strategy.factors._safe_ratio` (its NaN →
    our None), so the surfaced leg equals the live factor's pre-z-score value. A ≤0 denominator
    (negative-equity ROE, no-revenue margin, ≤0 market cap) collapses to None rather than manufacturing a
    finite score from no signal."""
    if denominator is None or not math.isfinite(denominator) or denominator <= 0:
        return None
    if numerator is None or not math.isfinite(numerator):
        return None
    return numerator / denominator


def _opt(line_items: dict[str, float], key: str) -> Optional[float]:
    """A line item as a finite float, or None when absent/non-finite (so a stored NaN/inf is treated as
    absent — never propagated into a ratio)."""
    if key not in line_items:
        return None
    try:
        v = float(line_items[key])
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def compute_factor_inputs(line_items: dict[str, float]) -> dict[str, Optional[float]]:
    """The value + quality factor legs for one name's PIT line items.

    Returns a dict of the six z-scored legs (each None when its inputs are unavailable — the factor
    NaN-excludes it) PLUS the raw drivers (net_income, total_equity, market_cap_gbp, shares_outstanding,
    gross_profit, total_revenue, total_debt, dividend_yield) so a consumer can hand-verify the
    arithmetic. `market_cap_gbp` is the computed PIT value (Gap 2) when present.

    Leg definitions are byte-for-byte the live factors':
      earnings_yield = net_income / market_cap_gbp        book_to_market = total_equity / market_cap_gbp
      roe            = net_income / total_equity           gross_margin   = gross_profit / total_revenue
      leverage       = -(total_debt / total_equity)        dividend_yield = the host-supplied PIT leg
    """
    net_income = _opt(line_items, "net_income")
    total_equity = _opt(line_items, "total_equity")
    market_cap_gbp = _opt(line_items, "market_cap_gbp")
    gross_profit = _opt(line_items, "gross_profit")
    total_revenue = _opt(line_items, "total_revenue")
    total_debt = _opt(line_items, "total_debt")
    dividend_yield = _opt(line_items, "dividend_yield")
    shares_outstanding = _opt(line_items, "shares_outstanding")

    leverage_ratio = _safe_ratio(total_debt, total_equity)
    leverage = (-leverage_ratio) if leverage_ratio is not None else None

    return {
        # Value legs
        "earnings_yield": _safe_ratio(net_income, market_cap_gbp),
        "book_to_market": _safe_ratio(total_equity, market_cap_gbp),
        "dividend_yield": dividend_yield,
        # Quality legs
        "roe": _safe_ratio(net_income, total_equity),
        "gross_margin": _safe_ratio(gross_profit, total_revenue),
        "leverage": leverage,
        # Raw drivers (for hand-verification + the market-cap provenance)
        "net_income": net_income,
        "total_equity": total_equity,
        "market_cap_gbp": market_cap_gbp,
        "shares_outstanding": shares_outstanding,
        "gross_profit": gross_profit,
        "total_revenue": total_revenue,
        "total_debt": total_debt,
    }
