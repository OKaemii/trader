"""Contract + import-hygiene tests for the lake-backed fundamentals-api (epic Task 10).

These pin the invariants the seam consumers + the deploy health depend on:

  1. The resolver projects EXACTLY the shared `quant_core.fundamentals.LINE_ITEMS` vocabulary — it
     IMPORTS the tuple, never re-lists keys (re-listing reintroduces the writer/reader drift the shared
     contract exists to prevent).
  2. The whole module tree imports with NO live Timescale/Mongo/Redis connection (the skeleton
     invariant) — a top-level driver import would crash-loop the pod, so this smoke test is the deploy-
     health proxy. (The lake drivers duckdb/pyarrow are imported at Store CONSTRUCTION, not module load.)
  3. The routes mount under the collision-free `…-pit` prefixes, and `/quarantine` is GONE (decision D).
"""
from __future__ import annotations


def test_line_items_imported_from_quant_core_not_relisted() -> None:
    # The single source of truth.
    from quant_core.fundamentals import LINE_ITEMS

    import src.resolver as resolver

    # The resolver's projection set is the imported tuple, and every key it can emit is a LINE_ITEMS
    # member.
    assert resolver.LINE_ITEM_SET == set(LINE_ITEMS)
    assert resolver.LINE_ITEM_SET.issubset(set(LINE_ITEMS))


def test_source_for_routes_by_suffix() -> None:
    from quant_core.fundamentals import SOURCE_PIT_COMPANIES_HOUSE, SOURCE_PIT_EDGAR

    from src.resolver import source_for

    assert source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR
    assert source_for("BPl_EQ") == SOURCE_PIT_COMPANIES_HOUSE


def test_as_of_bucket_live_vs_bucketed() -> None:
    from src.resolver import as_of_bucket, cache_key

    assert as_of_bucket(None) == "live"
    # Two instants in the same 60s window share a bucket (live consumers calling with ≈now coalesce).
    assert as_of_bucket(1_600_000_000_123) == as_of_bucket(1_600_000_000_999)
    assert as_of_bucket(1_600_000_000_000) != as_of_bucket(1_600_000_060_000)
    # The cache namespace is distinct from the bars (`bars:pg:v1:`) AND the old Timescale resolver
    # (`fund:pg:v1:`) caches, so a stale pre-cutover entry can't be served by the lake-backed read.
    assert cache_key("AAPL_US_EQ", None).startswith("fund:lake:v1:")


def test_app_and_modules_import_driver_free() -> None:
    # Importing the app + the read modules must not require a Postgres/Mongo driver or open any socket
    # (the lake drivers are imported at Store construction; redis/httpx lazily in handlers). A regression
    # here crash-loops the deployed pod.
    import src.main  # noqa: F401
    import src.resolver  # noqa: F401
    import src.store  # noqa: F401

    assert src.main.SERVICE_NAME == "fundamentals-api"


def test_routes_mounted_under_collision_free_prefixes() -> None:
    # The read API owns `/admin/api/fundamentals-pit` + `/internal/api/fundamentals-pit`, NEVER
    # `/admin/api/fundamentals-ingest` (the harvester) nor the bare `/internal/api/fundamentals`
    # (market-data-service).
    from src.main import app

    paths = {r.path for r in app.routes}
    assert "/internal/api/fundamentals-pit" in paths
    assert "/admin/api/fundamentals-pit/pit" in paths
    assert "/admin/api/fundamentals-pit/factors" in paths
    assert "/admin/api/fundamentals-pit/coverage" in paths
    assert "/admin/api/fundamentals-pit/health" in paths
    # `/quarantine` was removed in the lake rewrite (decision D — no quarantine in the lake design).
    assert "/admin/api/fundamentals-pit/quarantine" not in paths
    # Must NOT steal the existing routes.
    assert "/internal/api/fundamentals" not in paths
    assert "/admin/api/fundamentals-ingest" not in paths


def test_market_cap_and_factors_kept_verbatim_importable() -> None:
    # market_cap.py + factors.py are lake-agnostic and kept ~verbatim; assert they still import and
    # expose the functions the resolver/handlers call (the Gap-2 enrichment + the 6 factor legs).
    from src.factors import compute_factor_inputs
    from src.market_cap import (
        apply_dividend_yield,
        apply_pit_market_cap,
        compute_market_cap_gbp,
        currency_of,
    )

    # currency_of routes the T212 suffix → the FX currency (unchanged behaviour).
    assert currency_of("AAPL_US_EQ") == "USD"
    assert currency_of("BPl_EQ") == "GBP"
    # the pure market-cap identity is intact.
    assert compute_market_cap_gbp(10.0, 2.0, 0.5) == 10.0 * 2.0 * 0.5
    assert compute_market_cap_gbp(None, 2.0, 0.5) is None
    # apply_* + the factor legs are importable (exercised fully in test_market_cap/test_factors).
    assert apply_pit_market_cap({}, None) == {}
    assert apply_dividend_yield({}, None) == {}
    assert "roe" in compute_factor_inputs({})
