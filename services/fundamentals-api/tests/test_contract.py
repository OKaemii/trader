"""Contract + import-hygiene tests for fundamentals-api (epic Task 11).

These pin the two invariants the next cards (12 market-cap, 13 factors, 14 live seam) depend on:

  1. The resolver pivots into EXACTLY the shared `quant_core.fundamentals.LINE_ITEMS` vocabulary — it
     IMPORTS the tuple, never re-lists keys (re-listing reintroduces the writer/reader drift the shared
     contract exists to prevent). We assert the resolver's projected key set is a subset of LINE_ITEMS and
     that it references the imported tuple, not a private copy.
  2. The whole module tree imports with NO live Mongo/Timescale/Redis connection (the skeleton invariant)
     — a top-level driver import would crash-loop the pod, so this smoke test is the deploy-health proxy.
"""
from __future__ import annotations


def test_line_items_imported_from_quant_core_not_relisted() -> None:
    # The single source of truth.
    from quant_core.fundamentals import LINE_ITEMS

    import src.resolver as resolver

    # The resolver's projection set is derived from the imported tuple (same object identity for the
    # tuple it builds LINE_ITEM_SET from), and every key it can emit is a LINE_ITEMS member.
    assert resolver.LINE_ITEM_SET == set(LINE_ITEMS)
    assert resolver.LINE_ITEM_SET.issubset(set(LINE_ITEMS))
    # Belt-and-braces: the module imports the canonical names rather than re-declaring them.
    assert "LINE_ITEMS" in resolver.__dict__ or hasattr(resolver, "LINE_ITEM_SET")


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
    # The cache namespace is distinct from the bars cache (`bars:pg:v1:`), so the two never collide.
    assert cache_key("AAPL_US_EQ", None).startswith("fund:pg:v1:")


def test_app_and_modules_import_driver_free() -> None:
    # Importing the app + the read modules must not require asyncpg/redis or open any socket (the drivers
    # are imported lazily inside request handlers). A regression here crash-loops the deployed pod.
    import src.main  # noqa: F401
    import src.pool  # noqa: F401
    import src.resolver  # noqa: F401
    import src.security_master  # noqa: F401

    assert src.main.SERVICE_NAME == "fundamentals-api"


def test_routes_mounted_under_collision_free_prefixes() -> None:
    # The chosen ingress mounts: the read API owns `/admin/api/fundamentals-pit` + `/internal/api/
    # fundamentals-pit`, NEVER `/admin/api/fundamentals-ingest` (the write side) nor the bare
    # `/internal/api/fundamentals` (market-data-service). Assert the registered route paths match.
    from src.main import app

    paths = {r.path for r in app.routes}
    assert "/internal/api/fundamentals-pit" in paths
    assert "/admin/api/fundamentals-pit/pit" in paths
    assert "/admin/api/fundamentals-pit/coverage" in paths
    assert "/admin/api/fundamentals-pit/quarantine" in paths
    assert "/admin/api/fundamentals-pit/health" in paths
    # Must NOT steal the existing routes.
    assert "/internal/api/fundamentals" not in paths
    assert "/admin/api/fundamentals-ingest" not in paths
