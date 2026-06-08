"""Pure QA-check tests — sector-aware identity, outliers, missing-data (epic Task 8).

The heart of Task 8's acceptance: a balance-sheet identity break quarantines under the GENERAL template;
the SAME numbers under a BANK template do NOT falsely quarantine (a bank's unclassified balance sheet
must never be flagged on the General additive identity — the plan's "sector identity break" edge case);
an outlier (Revenue +5000% / Assets −99% / a sign flip) and a missing-shares case each produce a finding
with the RIGHT reason. All pure functions over fixture-built `InterpretedFact`s — no DB, no network.
"""
from __future__ import annotations

from src.normalize.sectors import (
    TEMPLATE_BANK,
    TEMPLATE_GENERAL,
    TEMPLATE_INSURANCE,
    TEMPLATE_REIT,
    TEMPLATE_UTILITY,
)
from src.qa.checks import (
    REASON_IDENTITY_BREAK,
    REASON_MISSING_DATA,
    REASON_OUTLIER,
    check_balance_sheet_identity,
    check_missing_data,
    check_outliers,
    run_checks,
)
from src.stage.resolver import InterpretedFact

_PERIOD_END = 1_600_000_000_000  # an arbitrary fixed observation period_end (UTC ms)


def _instant(metric: str, value, *, dim: str = "", period_end: int = _PERIOD_END) -> InterpretedFact:
    """A consolidated (or, with `dim`, a segment) balance-sheet INSTANT fact for `metric`. The QA checks
    read metric/value/period_end/dim_signature/is_segment off this — the rest is provenance the checks
    ignore but the dataclass requires."""
    return InterpretedFact(
        metric=metric, cik="0000000000", value=value, unit="USD", currency="USD",
        period_start=None, period_end=period_end, period_type="instant",
        fiscal_year=2020, fiscal_period="FY", dim_signature=dim, is_segment=bool(dim),
        raw_tag=f"us-gaap:{metric}", accession_number="acc-1", knowledge_ts=None,
    )


def _duration(metric: str, value, *, dim: str = "", period_end: int = _PERIOD_END) -> InterpretedFact:
    """A consolidated income/cash-flow DURATION fact (revenue, net_income, …)."""
    return InterpretedFact(
        metric=metric, cik="0000000000", value=value, unit="USD", currency="USD",
        period_start=period_end - 365 * 86_400_000, period_end=period_end, period_type="duration",
        fiscal_year=2020, fiscal_period="FY", dim_signature=dim, is_segment=bool(dim),
        raw_tag=f"us-gaap:{metric}", accession_number="acc-1", knowledge_ts=None,
    )


# A clean, balancing General-template balance sheet: Assets = Liabilities + Equity exactly.
def _balancing_sheet() -> list[InterpretedFact]:
    return [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 600.0),
        _instant("total_equity", 400.0),
    ]


# The SAME magnitudes but with Liabilities mis-tagged so the additive identity is grossly violated
# (Assets 1000 vs L+E = 600+ wrong). A bank legitimately reports figures that don't satisfy the General
# additive identity (its `Liabilities` tag is absent or non-additive) — here we model the break with a
# Liabilities value that does NOT complete Assets, the shape a financial filing routinely produces.
def _nonbalancing_sheet() -> list[InterpretedFact]:
    return [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 50.0),    # 50 + 400 = 450 ≠ 1000 → a 55% break
        _instant("total_equity", 400.0),
    ]


# ── 1. Sector-aware balance-sheet identity ─────────────────────────────────────────
def test_identity_break_quarantines_under_general() -> None:
    findings = check_balance_sheet_identity(_nonbalancing_sheet(), sector=TEMPLATE_GENERAL)
    assert len(findings) == 1
    f = findings[0]
    assert f.reason == REASON_IDENTITY_BREAK
    assert f.metric == "total_assets"
    assert f.observation_ts == _PERIOD_END
    assert f.detail["check"] == "balance_sheet_identity"
    assert f.detail["sector"] == TEMPLATE_GENERAL
    assert f.detail["liabilities_plus_equity"] == 450.0
    assert f.detail["total_assets"] == 1_000.0
    assert f.detail["rel_diff"] > f.detail["rel_tol"]


def test_same_numbers_under_bank_template_do_not_quarantine() -> None:
    # THE false-positive the plan's sector-identity-break edge case names: the IDENTICAL non-balancing
    # numbers, classified as a BANK, must NOT be flagged — the General additive identity does not apply.
    findings = check_balance_sheet_identity(_nonbalancing_sheet(), sector=TEMPLATE_BANK)
    assert findings == ()


def test_non_general_templates_all_skip_the_identity() -> None:
    # Every non-general template skips the additive identity (none reconstructs it from the registry's
    # normalized legs) — so a non-balancing financial/utility sheet is never falsely quarantined.
    for sector in (TEMPLATE_BANK, TEMPLATE_INSURANCE, TEMPLATE_REIT, TEMPLATE_UTILITY):
        assert check_balance_sheet_identity(_nonbalancing_sheet(), sector=sector) == ()


def test_balancing_sheet_under_general_is_clean() -> None:
    assert check_balance_sheet_identity(_balancing_sheet(), sector=TEMPLATE_GENERAL) == ()


def test_identity_within_tolerance_is_clean() -> None:
    # A 0.5% mismatch (< the 1% identity tolerance) is rounding noise, not a break.
    facts = [
        _instant("total_assets", 1_000.0),
        _instant("total_liabilities", 600.0),
        _instant("total_equity", 405.0),   # L+E = 1005 → 0.5% over Assets, within tol
    ]
    assert check_balance_sheet_identity(facts, sector=TEMPLATE_GENERAL) == ()


def test_identity_needs_all_three_legs_present() -> None:
    # A missing leg is a MISSING-DATA concern, not an identity break — we never fabricate the absent leg
    # as 0 and then "fail" the identity. With only Assets + Equity (no Liabilities), no identity finding.
    facts = [_instant("total_assets", 1_000.0), _instant("total_equity", 400.0)]
    assert check_balance_sheet_identity(facts, sector=TEMPLATE_GENERAL) == ()


def test_identity_ignores_segment_rows() -> None:
    # A balancing consolidated sheet plus a non-balancing SEGMENT breakout: the segment must not enter
    # the consolidated identity (it would falsely fail). Only dim_signature='' facts are summed.
    facts = _balancing_sheet() + [
        _instant("total_assets", 10.0, dim="Seg=A"),
        _instant("total_liabilities", 999.0, dim="Seg=A"),
    ]
    assert check_balance_sheet_identity(facts, sector=TEMPLATE_GENERAL) == ()


# ── 2. Outlier detection ────────────────────────────────────────────────────────────
def test_revenue_spike_quarantines_as_outlier() -> None:
    # Revenue +5000% (51x) vs the prior period → a spike outlier.
    facts = [_duration("total_revenue", 5_100.0)]
    findings = check_outliers(facts, prior_values={("total_revenue", ""): 100.0})
    assert len(findings) == 1
    f = findings[0]
    assert f.reason == REASON_OUTLIER and f.metric == "total_revenue"
    assert f.detail["check"] == "period_ratio" and f.detail["direction"] == "spike"
    assert f.detail["current"] == 5_100.0 and f.detail["prior"] == 100.0


def test_assets_collapse_quarantines_as_outlier() -> None:
    # Assets −99% (0.01x) vs prior → a collapse outlier.
    facts = [_instant("total_assets", 10.0)]
    findings = check_outliers(facts, prior_values={("total_assets", ""): 1_000.0})
    assert len(findings) == 1
    assert findings[0].reason == REASON_OUTLIER
    assert findings[0].detail["direction"] == "collapse"


def test_sign_flip_on_sign_stable_metric_quarantines() -> None:
    # Total equity going from +500 to −500 is a sign flip on a sign-stable stock → flagged as an
    # outlier with the sign_flip discriminator (not the ratio check — |ratio| here is 1.0).
    facts = [_instant("total_equity", -500.0)]
    findings = check_outliers(facts, prior_values={("total_equity", ""): 500.0})
    assert len(findings) == 1
    assert findings[0].reason == REASON_OUTLIER
    assert findings[0].detail["check"] == "sign_flip"


def test_net_income_sign_change_is_not_a_sign_flip_outlier() -> None:
    # net_income legitimately goes negative (a loss) — it is NOT in SIGN_STABLE_METRICS, so a profit→loss
    # swing of comparable magnitude is not a sign-flip finding (and a 1x ratio isn't a magnitude outlier).
    facts = [_duration("net_income", -90.0)]
    assert check_outliers(facts, prior_values={("net_income", ""): 100.0}) == ()


def test_no_prior_value_is_not_an_outlier() -> None:
    # A first-ever observation (no prior baseline) can't be an outlier — skipped, not flagged.
    facts = [_duration("total_revenue", 1_000_000.0)]
    assert check_outliers(facts, prior_values={}) == ()


def test_moderate_growth_is_not_an_outlier() -> None:
    # A real 3x revenue growth is within the (wide) thresholds — not flagged (a false outlier-quarantine
    # would drop a good fact).
    facts = [_duration("total_revenue", 300.0)]
    assert check_outliers(facts, prior_values={("total_revenue", ""): 100.0}) == ()


def test_zero_prior_to_nonzero_is_a_spike() -> None:
    # A metric that was 0 and is now non-zero is an unbounded jump → a spike (ratio recorded as null).
    facts = [_instant("total_assets", 500.0)]
    findings = check_outliers(facts, prior_values={("total_assets", ""): 0.0})
    assert len(findings) == 1 and findings[0].detail["direction"] == "spike"
    assert findings[0].detail["ratio"] is None


def test_outlier_check_ignores_segment_rows() -> None:
    # A segment can legitimately swing wildly — only consolidated facts are outlier-checked.
    facts = [_duration("total_revenue", 5_100.0, dim="Seg=A")]
    assert check_outliers(facts, prior_values={("total_revenue", ""): 100.0}) == ()


# ── 3. Missing-data ──────────────────────────────────────────────────────────────────
def test_missing_shares_quarantines_as_missing_data() -> None:
    # A filing with revenue/income/equity/assets but NO shares_outstanding → a missing-data finding for
    # shares_outstanding specifically (the others are present).
    facts = [
        _duration("total_revenue", 1_000.0),
        _duration("net_income", 100.0),
        _instant("total_equity", 400.0),
        _instant("total_assets", 1_000.0),
        # no shares_outstanding
    ]
    findings = check_missing_data(facts)
    missing_metrics = {f.metric for f in findings}
    assert "shares_outstanding" in missing_metrics
    shares = next(f for f in findings if f.metric == "shares_outstanding")
    assert shares.reason == REASON_MISSING_DATA
    assert shares.detail["check"] == "missing_required_metric"


def test_all_required_present_is_clean() -> None:
    facts = [
        _duration("total_revenue", 1_000.0),
        _duration("net_income", 100.0),
        _instant("total_equity", 400.0),
        _instant("total_assets", 1_000.0),
        _instant("shares_outstanding", 1_000_000.0),
    ]
    assert check_missing_data(facts) == ()


def test_empty_filing_reports_every_required_metric_missing() -> None:
    findings = check_missing_data([])
    assert {f.reason for f in findings} == {REASON_MISSING_DATA}
    assert {f.metric for f in findings} == {
        "total_revenue", "net_income", "total_equity", "total_assets", "shares_outstanding",
    }


def test_none_value_does_not_satisfy_required() -> None:
    # A resolved-but-None shares fact does not count as present (a missing value is missing data).
    facts = [_instant("shares_outstanding", None)]
    missing = {f.metric for f in check_missing_data(facts)}
    assert "shares_outstanding" in missing


def test_segment_only_does_not_satisfy_required() -> None:
    # Segment-only coverage of a required metric does NOT satisfy it (factors read consolidated totals).
    facts = [_duration("total_revenue", 1_000.0, dim="Seg=A")]
    missing = {f.metric for f in check_missing_data(facts)}
    assert "total_revenue" in missing


# ── run_checks (the engine entry point) ──────────────────────────────────────────────
def test_run_checks_combines_all_families_under_general() -> None:
    # A non-balancing General sheet, missing shares, with one outlier — all three reasons appear.
    facts = _nonbalancing_sheet() + [
        _duration("total_revenue", 5_100.0),  # spike vs prior 100
        # net_income present so it isn't a missing-data finding; shares_outstanding absent → missing
        _duration("net_income", 50.0),
    ]
    findings = run_checks(
        facts, sector=TEMPLATE_GENERAL, prior_values={("total_revenue", ""): 100.0}
    )
    reasons = {f.reason for f in findings}
    assert reasons == {REASON_IDENTITY_BREAK, REASON_OUTLIER, REASON_MISSING_DATA}


def test_run_checks_bank_skips_identity_but_keeps_outlier_and_missing() -> None:
    # The same facts under BANK: NO identity break (skipped), but the outlier + missing-data still fire.
    facts = _nonbalancing_sheet() + [_duration("total_revenue", 5_100.0)]
    findings = run_checks(
        facts, sector=TEMPLATE_BANK, prior_values={("total_revenue", ""): 100.0}
    )
    reasons = {f.reason for f in findings}
    assert REASON_IDENTITY_BREAK not in reasons
    assert REASON_OUTLIER in reasons
    assert REASON_MISSING_DATA in reasons  # shares_outstanding still absent
