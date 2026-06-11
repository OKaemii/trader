"""Dual-class share consolidation (epic post-pit-coverage-bugs, Tasks 6/7) — the pure derivation.

Covers the 1:1 naive-sum regime (META/MA/Alphabet), the Visa as-converted regime, and every
fail-closed branch (partial recovery, unknown CIK, missing/insane/out-of-band Visa ratio). No network,
no DB — `derive_consolidated_shares` is a pure function over RawFacts.
"""
from __future__ import annotations

from src.download.edgar import RawFact
from src.stage.class_shares import (
    ALPHABET_CIK,
    MASTERCARD_CIK,
    META_CIK,
    VISA_CIK,
    derive_consolidated_shares,
)

AXIS = "us-gaap:StatementClassOfStockAxis"
_PERIOD_END = 1_711_843_200_000  # 2024-03-31


def _share(member: str, value: float, *, period_end: int = _PERIOD_END) -> RawFact:
    return RawFact(
        taxonomy="dei", tag="EntityCommonStockSharesOutstanding", period_type="instant",
        period_start=None, period_end=period_end, value=value, unit="shares", currency=None,
        accession_number="0001326801-24-000012", fiscal_year=None, fiscal_period=None, form=None,
        context_id="c", dim_signature=f"{AXIS}={member}",
    )


def _ratio(member: str, value: float) -> RawFact:
    return RawFact(
        taxonomy="us-gaap", tag="ConvertibleCommonStockConversionRatio", period_type="instant",
        period_start=None, period_end=_PERIOD_END, value=value, unit="pure", currency=None,
        accession_number="0001403161-24-000050", fiscal_year=None, fiscal_period=None, form=None,
        context_id="c", dim_signature=f"{AXIS}={member}",
    )


def test_meta_sums_class_a_and_b_into_consolidated() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 2_196_045_588),
        _share("us-gaap:CommonClassBMember", 342_377_716),
    ]
    out = derive_consolidated_shares(facts, cik=META_CIK, accession="0001326801-24-000012")
    assert out is not None
    assert out.metric == "shares_outstanding"
    assert out.value == 2_196_045_588 + 342_377_716
    assert out.dim_signature == ""              # consolidated
    assert out.is_segment is False
    assert out.unit == "shares"
    assert out.raw_tag.startswith("derived:")   # provenance-marked, never a single reported tag
    assert out.period_end == _PERIOD_END


def test_mastercard_sums_two_classes() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 920_000_000),
        _share("us-gaap:CommonClassBMember", 9_000_000),
    ]
    out = derive_consolidated_shares(facts, cik=MASTERCARD_CIK, accession="x")
    assert out is not None and out.value == 929_000_000


def test_alphabet_sums_three_classes() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 5_800_000_000),
        _share("us-gaap:CommonClassBMember", 870_000_000),
        _share("us-gaap:CommonClassCMember", 5_700_000_000),
    ]
    out = derive_consolidated_shares(facts, cik=ALPHABET_CIK, accession="x")
    assert out is not None and out.value == 5_800_000_000 + 870_000_000 + 5_700_000_000


def test_fungible_partial_recovery_fails_closed() -> None:
    # Only Class A recovered for a known dual-class name → undercount guard → None (degrade to Yahoo).
    facts = [_share("us-gaap:CommonClassAMember", 2_196_045_588)]
    assert derive_consolidated_shares(facts, cik=META_CIK, accession="x") is None


def test_unknown_cik_never_guesses() -> None:
    # AAPL is single-class and not in the dual-class set — never synthesize a sum.
    facts = [_share("us-gaap:CommonClassAMember", 15_000_000_000)]
    assert derive_consolidated_shares(facts, cik="0000320193", accession="x") is None


def test_empty_class_facts_fails_closed() -> None:
    assert derive_consolidated_shares([], cik=META_CIK, accession="x") is None


def test_visa_as_converted_uses_conversion_ratios() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 1_659_709_932),
        _share("v:CommonClassBMember", 245_000_000),
        _share("v:CommonClassCMember", 9_000_000),
        _ratio("v:CommonClassBMember", 0.5),
        _ratio("v:CommonClassCMember", 1.0),
    ]
    out = derive_consolidated_shares(facts, cik=VISA_CIK, accession="0001403161-24-000050")
    assert out is not None
    expected = 1_659_709_932 + 245_000_000 * 0.5 + 9_000_000 * 1.0
    assert out.value == expected
    assert out.dim_signature == "" and out.raw_tag.startswith("derived:")


def test_visa_missing_ratio_fails_closed() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 1_659_709_932),
        _share("v:CommonClassBMember", 245_000_000),  # no ratio for B → fail-closed
    ]
    assert derive_consolidated_shares(facts, cik=VISA_CIK, accession="x") is None


def test_visa_insane_ratio_fails_closed() -> None:
    facts = [
        _share("us-gaap:CommonClassAMember", 1_659_709_932),
        _share("v:CommonClassBMember", 245_000_000),
        _ratio("v:CommonClassBMember", 2.0),  # > 1.5 → rejected
    ]
    assert derive_consolidated_shares(facts, cik=VISA_CIK, accession="x") is None


def test_visa_out_of_band_total_fails_closed() -> None:
    # Class B shares so large the as-converted total exceeds 3× Class A → a mis-parse slipped in → None.
    facts = [
        _share("us-gaap:CommonClassAMember", 1_000_000_000),
        _share("v:CommonClassBMember", 5_000_000_000),
        _ratio("v:CommonClassBMember", 1.0),
    ]
    assert derive_consolidated_shares(facts, cik=VISA_CIK, accession="x") is None
