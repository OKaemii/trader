"""Module-import smoke test — every skeleton subpackage imports cleanly, and the quant-core
fundamentals contract (the cross-package surface the real ingestion stages will consume) is reachable
from this service's environment.

This is the cheap guard that keeps the skeleton honest as later tasks fill the stubs in: if any stage
module grows an import that isn't installed, or the `quant_core.fundamentals` contract drifts out from
under the writer/stage layers, this test fails at the gate rather than at deploy time. It asserts the
*spelling* contract too — `total_revenue`/`shares_outstanding` etc. are the keys `normalize`/`stage`
must pivot into, so pinning them here ties the write-side to the same `LINE_ITEMS` tuple the factors
read."""
from __future__ import annotations

import importlib


def test_stage_modules_import() -> None:
    # Each future ingestion stage is its own subpackage; importing them all proves the tree is wired
    # and nothing in a stub __init__ references an uninstalled dependency.
    for mod in (
        "src.main",
        "src.security_master",
        "src.download",
        "src.raw_store",
        "src.stage",
        "src.normalize",
        "src.qa",
    ):
        assert importlib.import_module(mod) is not None


def test_quant_core_fundamentals_contract_reachable() -> None:
    # The service installs quant-core first (Dockerfile), so the canonical contract Task 2 shipped is
    # importable here. normalize/stage will pivot raw facts into exactly these snake_case keys, and
    # market_of() is the jurisdiction router the downloader dispatches on — assert both are present.
    from quant_core.fundamentals import LINE_ITEMS, market_of

    for key in (
        "net_income",
        "total_equity",
        "total_assets",
        "current_assets",
        "current_liabilities",
        "total_debt",
        "total_revenue",
        "shares_outstanding",
        "market_cap_gbp",
    ):
        assert key in LINE_ITEMS

    assert market_of("AAPL_US_EQ") == "US"
    assert market_of("VODl_EQ") == "UK"
    assert market_of("XYZ") == "OTHER"
