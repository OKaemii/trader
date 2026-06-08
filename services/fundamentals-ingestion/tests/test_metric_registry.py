"""Metric registry loader + validation tests (epic Task 6).

The registry is DATA (a versioned YAML), so these tests cover: the packaged file loads + validates;
the canonical-key guard rejects a non-LINE_ITEMS metric; sector overrides + the empty-list "no tag"
sentinel; the flow-metric set; and the reverse `metrics_for_tag` index the resolver relies on. Pure —
`parse_registry` is a total function over already-decoded YAML, so most assertions need no file I/O.
"""
from __future__ import annotations

import pytest

from quant_core.fundamentals.contract import LINE_ITEMS
from src.stage.registry import (
    DEFAULT_SECTOR,
    default_registry,
    load_registry,
    parse_registry,
)


# ── the packaged registry ─────────────────────────────────────────────────────
def test_packaged_registry_loads_and_validates() -> None:
    reg = default_registry()
    assert reg.version >= 1
    # Every mapped metric is a canonical LINE_ITEMS key (the load-time guard would have raised
    # otherwise) — proves the registry never drifts to a spelling the factors don't read.
    assert set(reg.metrics()) <= set(LINE_ITEMS)
    # The core income/balance-sheet metrics the QMJ screen + factors need are mapped.
    for metric in ("net_income", "total_revenue", "total_equity", "total_assets", "total_liabilities",
                   "current_assets", "current_liabilities", "total_debt", "gross_profit",
                   "cash_flow_ops", "shares_outstanding"):
        assert reg.candidates(metric), f"{metric} has no default candidates"


def test_default_registry_is_cached_singleton() -> None:
    assert default_registry() is default_registry()


def test_shares_outstanding_maps_to_dei_tag_only() -> None:
    reg = default_registry()
    assert reg.candidates("shares_outstanding") == ("dei:EntityCommonStockSharesOutstanding",)


def test_revenue_default_preference_order() -> None:
    reg = default_registry()
    rev = reg.candidates("total_revenue")
    # Contract-revenue tag is most-preferred; Revenues is a fallback after it.
    assert rev[0] == "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"
    assert "us-gaap:Revenues" in rev
    assert rev.index("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax") < rev.index("us-gaap:Revenues")


def test_bank_revenue_override_differs_from_default() -> None:
    reg = default_registry()
    assert reg.candidates("total_revenue", "bank")[0] == "us-gaap:RevenuesNetOfInterestExpense"
    assert reg.candidates("total_revenue", "bank") != reg.candidates("total_revenue")


def test_empty_sector_override_means_no_tag() -> None:
    # gross_profit / current_assets have an empty bank override → "no tag for a bank" (not a fall-through
    # to the general default). The resolver yields nothing for it; the factor NaN-excludes it.
    reg = default_registry()
    assert reg.candidates("gross_profit", "bank") == ()
    assert reg.candidates("current_assets", "bank") == ()
    # General still has the tag.
    assert reg.candidates("gross_profit") == ("us-gaap:GrossProfit",)


def test_unknown_sector_falls_back_to_general() -> None:
    reg = default_registry()
    assert reg.candidates("net_income", "spaceship") == reg.candidates("net_income", DEFAULT_SECTOR)


def test_flow_metrics_are_the_period_flows() -> None:
    reg = default_registry()
    for flow in ("net_income", "total_revenue", "gross_profit", "cash_flow_ops"):
        assert reg.is_flow_metric(flow)
    # Balance-sheet stocks are NOT flows.
    for instant in ("total_equity", "total_assets", "current_assets", "shares_outstanding"):
        assert not reg.is_flow_metric(instant)


def test_metrics_for_tag_reverse_index() -> None:
    reg = default_registry()
    assert "total_revenue" in reg.metrics_for_tag("us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax")
    assert "net_income" in reg.metrics_for_tag("us-gaap:NetIncomeLoss")
    # A bank's Revenues feeds total_revenue under the bank template …
    assert "total_revenue" in reg.metrics_for_tag("us-gaap:Revenues", "bank")
    # … and an unmapped tag feeds nothing.
    assert reg.metrics_for_tag("us-gaap:NotARealTag") == ()


def test_unknown_metric_raises() -> None:
    with pytest.raises(KeyError):
        default_registry().candidates("ebitda")   # not a LINE_ITEMS key


# ── parse_registry validation (pure) ──────────────────────────────────────────
def _valid_doc() -> dict:
    return {
        "version": 1,
        "flow_metrics": ["net_income"],
        "metrics": {
            "net_income": {"default": ["us-gaap:NetIncomeLoss"]},
            "total_equity": {
                "default": ["us-gaap:StockholdersEquity"],
                "sectors": {"bank": ["us-gaap:StockholdersEquity"]},
            },
        },
    }


def test_parse_registry_accepts_valid_doc() -> None:
    reg = parse_registry(_valid_doc())
    assert reg.version == 1
    assert reg.candidates("net_income") == ("us-gaap:NetIncomeLoss",)
    assert reg.is_flow_metric("net_income")


def test_parse_registry_rejects_non_canonical_metric() -> None:
    doc = _valid_doc()
    doc["metrics"]["revenue"] = {"default": ["us-gaap:Revenues"]}   # 'revenue' is not in LINE_ITEMS
    with pytest.raises(ValueError, match="canonical"):
        parse_registry(doc)


def test_parse_registry_requires_default_list() -> None:
    doc = _valid_doc()
    doc["metrics"]["total_assets"] = {"sectors": {}}                # no 'default'
    with pytest.raises(ValueError, match="default"):
        parse_registry(doc)


def test_parse_registry_rejects_bad_version() -> None:
    doc = _valid_doc()
    doc["version"] = "one"
    with pytest.raises(ValueError, match="version"):
        parse_registry(doc)


def test_parse_registry_rejects_bad_tag_entry() -> None:
    doc = _valid_doc()
    doc["metrics"]["net_income"]["default"] = ["NetIncomeLoss"]     # missing 'taxonomy:' prefix
    with pytest.raises(ValueError, match="bad tag entry"):
        parse_registry(doc)


def test_parse_registry_rejects_flow_metric_not_mapped() -> None:
    doc = _valid_doc()
    doc["flow_metrics"] = ["cash_flow_ops"]                         # not in this doc's metrics
    with pytest.raises(ValueError, match="not a mapped metric"):
        parse_registry(doc)


def test_parse_registry_rejects_non_mapping_top_level() -> None:
    with pytest.raises(ValueError):
        parse_registry(["not", "a", "mapping"])


def test_load_registry_from_explicit_path(tmp_path) -> None:
    import yaml
    p = tmp_path / "reg.yaml"
    p.write_text(yaml.safe_dump(_valid_doc()), encoding="utf-8")
    reg = load_registry(str(p))
    assert reg.candidates("net_income") == ("us-gaap:NetIncomeLoss",)
