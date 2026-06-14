"""Tests for ``quant_core.forecast`` Task 2 — the region seam + the scaled regression inputs.

Two pure modules, no synthetic lake (the brief: this layer does arithmetic + fail-closed filtering on
ALREADY-FETCHED values, so the tests feed plain values — no pyarrow / duckdb):

  * :mod:`quant_core.forecast.region` — ``region_of`` resolves EVERYTHING to ``'US'`` today (the only
    populated pool); the dev-ex-US / EM buckets are the card-131 forward seam (assert the seam exists
    and is wired, and that LSE — the card-131 candidate — still routes to ``'US'`` until then).
  * :mod:`quant_core.forecast.features` — ``build_firm_year_features`` builds one scaled firm-year row
    (E, A, B, D, DD, NegE, AC, all ÷ A) and drops broken rows BEFORE any winsorization. Pins the
    plan's done-when: ROA/payout computed; a financial gets ``AC = 0``; the sanity filter drops broken
    rows; the injected-dividend fallback path; fail-closed on missing legs (omit, never 0).
"""
from __future__ import annotations

from datetime import date

import pytest

from quant_core.forecast import build_firm_year_features, region_of
from quant_core.forecast.features import (
    MIN_ASSETS_FLOOR,
    ROA_SANITY_BOUND,
    FirmYearFeatures,
)
from quant_core.forecast.region import REGIONS
from quant_core.ticker_identity import TickerIdentity

FYE = date(2023, 12, 31)  # a representative annual period-end

# Test asset bases sit comfortably above MIN_ASSETS_FLOOR (1e6) so the sanity gate keeps the row and
# the arithmetic is what's under test. A scale of 1e9 (a real large-cap balance sheet) with round
# multiples keeps every ratio exact. The floor itself is exercised by the drop tests below.
SCALE = 1_000_000_000.0  # 1e9 — above MIN_ASSETS_FLOOR, ratios stay exact


# --------------------------------------------------------------------------------------------------- #
# region_of — the seam. Everything → 'US' today; the dev-ex-US / EM buckets are the card-131 seam.     #
# --------------------------------------------------------------------------------------------------- #
def test_us_name_is_us_region() -> None:
    assert region_of(TickerIdentity("AAPL", "US")) == "US"


def test_lse_name_routes_to_us_today() -> None:
    """The card-131 candidate (LSE) routes to ``'US'`` TODAY — there is no populated dev-ex-US pool
    yet (LSE names have no PIT fundamentals), so the seam must not label them into an empty bucket.
    This is the line that flips to ``'DEV_EX_US'`` once UK PIT lands."""
    assert region_of(TickerIdentity("SHEL", "LSE")) == "US"


def test_region_seam_exposes_all_three_buckets() -> None:
    """The three-way segmentation exists in the type system now (the forward seam), even though only
    ``US`` is populated — the cross-sectional / ensemble layers are written region-aware from day one.
    """
    assert REGIONS == ("US", "DEV_EX_US", "EM")


# --------------------------------------------------------------------------------------------------- #
# A fully-covered firm-year → every scaled input computed (ROA, payout, B/A, AC/A) + the dummies.      #
# --------------------------------------------------------------------------------------------------- #
def test_full_firm_year_computes_every_scaled_input() -> None:
    # E=120·s, A=1000·s, B=400·s, CFO=100·s ⇒ AC = E−CFO = 20·s; D=30·s  (s = SCALE = 1e9).
    row = build_firm_year_features(
        period_end=FYE,
        net_income=120.0 * SCALE,
        total_assets=1_000.0 * SCALE,
        total_equity=400.0 * SCALE,
        cash_flow_ops=100.0 * SCALE,
        dividends=30.0 * SCALE,
        knowledge_ts=1_700_000_000_000,
    )
    assert row is not None
    assert isinstance(row, FirmYearFeatures)
    # ÷ total assets → dimensionless ratios (the currency-free pool); the SCALE cancels.
    assert row.roa == pytest.approx(0.12)                 # 120 / 1000
    assert row.book_to_assets == pytest.approx(0.40)      # 400 / 1000
    assert row.payout == pytest.approx(0.03)              # 30 / 1000
    assert row.accruals == pytest.approx(20.0 * SCALE)    # E − CFO  (bare Hribar-Collins)
    assert row.accruals_to_assets == pytest.approx(0.02)  # 20 / 1000
    # the dummies
    assert row.neg_e == 0                                  # E > 0
    assert row.dd == 1                                     # D > 0  (dividend payer)
    # raw levels carried (A is kept for the predict-time ratio × A step)
    assert row.total_assets == 1_000.0 * SCALE
    assert row.net_income == 120.0 * SCALE
    assert row.period_end == FYE
    assert row.knowledge_ts == 1_700_000_000_000


def test_loss_year_sets_neg_e_dummy() -> None:
    """A loss year (E < 0) sets NegE = 1 and a negative ROA — the loss dummy the HVZ / LM regressions
    interact with E."""
    row = build_firm_year_features(
        period_end=FYE, net_income=-50.0 * SCALE, total_assets=1_000.0 * SCALE, total_equity=200.0 * SCALE
    )
    assert row is not None
    assert row.neg_e == 1
    assert row.roa == pytest.approx(-0.05)


# --------------------------------------------------------------------------------------------------- #
# Financials → AC = 0 (the construct is meaningless for banks / insurers).                             #
# --------------------------------------------------------------------------------------------------- #
def test_financial_gets_zero_accruals() -> None:
    """``is_financial=True`` forces ``AC = 0`` (and ``AC/A = 0``) REGARDLESS of CFO — the accrual
    construct does not apply to a bank / insurer. Note this is the ONE place a 0 is correct: it is the
    economically-meaningful value, not a fabricated stand-in for missing data."""
    row = build_firm_year_features(
        period_end=FYE,
        net_income=300.0 * SCALE,
        total_assets=10_000.0 * SCALE,
        total_equity=1_500.0 * SCALE,
        cash_flow_ops=275.0 * SCALE,  # would give AC=25·s for a non-financial — must be ignored here
        is_financial=True,
    )
    assert row is not None
    assert row.accruals == 0.0
    assert row.accruals_to_assets == 0.0


def test_non_financial_accruals_use_cfo() -> None:
    """The same inputs WITHOUT the financial flag → AC = E − CFO (so the financial override above is a
    real behaviour change, not a no-op)."""
    row = build_firm_year_features(
        period_end=FYE,
        net_income=300.0 * SCALE,
        total_assets=10_000.0 * SCALE,
        cash_flow_ops=275.0 * SCALE,
        is_financial=False,
    )
    assert row is not None
    assert row.accruals == pytest.approx(25.0 * SCALE)


# --------------------------------------------------------------------------------------------------- #
# Sanity filters drop broken rows — BEFORE any winsorization (returns None, listwise, never 0-filled). #
# --------------------------------------------------------------------------------------------------- #
def test_sub_floor_assets_dropped() -> None:
    """Total assets below the floor → the row is dropped (a near-zero denominator makes every ratio
    explode)."""
    assert (
        build_firm_year_features(
            period_end=FYE, net_income=10.0, total_assets=MIN_ASSETS_FLOOR - 1.0
        )
        is None
    )


def test_missing_assets_dropped() -> None:
    """No total assets → no deflator → the row cannot exist."""
    assert build_firm_year_features(period_end=FYE, net_income=10.0, total_assets=None) is None


def test_missing_net_income_dropped() -> None:
    """No net income → no label and no ROA → dropped (NOT zero-filled, which would fabricate a
    flat-earnings observation that never occurred)."""
    assert (
        build_firm_year_features(period_end=FYE, net_income=None, total_assets=5_000_000.0) is None
    )


def test_roa_beyond_sanity_bound_dropped() -> None:
    """|E/A| past the sanity bound → an accounting artefact, dropped BEFORE it can drag the
    within-cross-section winsor caps. E/A here = 2.0 > 1.5."""
    a = 10_000_000.0
    assert (
        build_firm_year_features(period_end=FYE, net_income=(ROA_SANITY_BOUND + 0.5) * a, total_assets=a)
        is None
    )


def test_roa_at_sanity_bound_kept() -> None:
    """The bound is inclusive on the keep side — exactly :data:`ROA_SANITY_BOUND` is retained (only
    *strictly* past it is dropped), so a name riding the edge is not silently lost."""
    a = 10_000_000.0
    row = build_firm_year_features(period_end=FYE, net_income=ROA_SANITY_BOUND * a, total_assets=a)
    assert row is not None
    assert row.roa == pytest.approx(ROA_SANITY_BOUND)


# --------------------------------------------------------------------------------------------------- #
# The injected-dividend fallback — lake D absent ⇒ the EODHD resolver fills it; a None resolver result #
# leaves the row a non-payer (fail-closed, not a fabricated 0-dividend).                               #
# --------------------------------------------------------------------------------------------------- #
def test_injected_dividend_fallback_used_when_lake_absent() -> None:
    """No lake ``dividends`` ⇒ the injected EODHD ``Σ DPS × shares`` resolver supplies D for the
    fiscal year, and ``payout`` / ``DD`` are computed off it."""
    calls: list[date] = []

    def resolver(end: date) -> float:
        calls.append(end)
        return 50.0 * SCALE  # Σ DPS × shares for this fiscal year

    row = build_firm_year_features(
        period_end=FYE,
        net_income=200.0 * SCALE,
        total_assets=2_000.0 * SCALE,
        dividends=None,  # lake has no dividends-paid fact
        dividend_resolver=resolver,
    )
    assert row is not None
    assert calls == [FYE]                              # resolver consulted for THIS fiscal year-end
    assert row.dividends == pytest.approx(50.0 * SCALE)
    assert row.payout == pytest.approx(0.025)          # 50 / 2000
    assert row.dd == 1


def test_lake_dividend_wins_over_resolver() -> None:
    """A present lake ``dividends`` value is used directly — the injected resolver is NOT consulted
    (lake first, EODHD only as the fallback)."""

    def resolver(end: date) -> float:
        raise AssertionError("resolver must not be called when the lake carries a dividend")

    row = build_firm_year_features(
        period_end=FYE,
        net_income=200.0 * SCALE,
        total_assets=2_000.0 * SCALE,
        dividends=80.0 * SCALE,
        dividend_resolver=resolver,
    )
    assert row is not None
    assert row.dividends == pytest.approx(80.0 * SCALE)
    assert row.payout == pytest.approx(0.04)


def test_unresolved_dividend_is_fail_closed_not_zero() -> None:
    """A resolver that returns ``None`` (no figure for the year) leaves ``dividends`` / ``payout`` /
    ``dd`` UNSET — "no dividend data" is not "paid zero" (fail-closed: only a populated value asserts a
    payout). The row still exists (E + A resolved), just without the dividend legs."""

    def resolver(end: date) -> None:
        return None

    row = build_firm_year_features(
        period_end=FYE,
        net_income=200.0 * SCALE,
        total_assets=2_000.0 * SCALE,
        dividends=None,
        dividend_resolver=resolver,
    )
    assert row is not None
    assert row.dividends is None
    assert row.payout is None
    assert row.dd is None


def test_known_non_payer_is_dd_zero() -> None:
    """A POPULATED dividend of 0 (a known non-payer, feed says so) IS ``DD = 0`` / ``payout = 0`` —
    distinct from the unresolved-None case above. This is the other place a 0 is the honest value."""
    row = build_firm_year_features(
        period_end=FYE, net_income=200.0 * SCALE, total_assets=2_000.0 * SCALE, dividends=0.0
    )
    assert row is not None
    assert row.dd == 0
    assert row.payout == pytest.approx(0.0)
    assert row.dividends == pytest.approx(0.0)


# --------------------------------------------------------------------------------------------------- #
# Fail-closed on missing optional legs — omitted (None), NEVER coerced to 0.                           #
# --------------------------------------------------------------------------------------------------- #
def test_missing_book_value_omitted_not_zero() -> None:
    """No ``total_equity`` ⇒ ``total_equity`` / ``book_to_assets`` stay ``None`` (a fabricated 0 book
    would corrupt the RI regression's χ4·(B/A) term)."""
    row = build_firm_year_features(period_end=FYE, net_income=100.0 * SCALE, total_assets=1_000.0 * SCALE)
    assert row is not None
    assert row.total_equity is None
    assert row.book_to_assets is None


def test_missing_cfo_omits_accruals_for_non_financial() -> None:
    """A non-financial with no CFO ⇒ accruals are OMITTED (None), never a fabricated 0 (which would
    claim perfect articulation). Contrast the financial path, where 0 is the meaningful value."""
    row = build_firm_year_features(
        period_end=FYE, net_income=100.0 * SCALE, total_assets=1_000.0 * SCALE, is_financial=False
    )
    assert row is not None
    assert row.accruals is None
    assert row.accruals_to_assets is None


def test_mandatory_only_row_carries_just_the_guaranteed_legs() -> None:
    """The minimal viable row (only E + A resolved) exists with ROA + NegE set and every optional leg
    ``None`` — the fail-closed shape the cross-sectional layer NaN-excludes per missing column."""
    row = build_firm_year_features(period_end=FYE, net_income=75.0 * SCALE, total_assets=1_500.0 * SCALE)
    assert row is not None
    assert row.roa == pytest.approx(0.05)
    assert row.neg_e == 0
    assert row.total_equity is None and row.book_to_assets is None
    assert row.dividends is None and row.payout is None and row.dd is None
    assert row.accruals is None and row.accruals_to_assets is None
