"""Smoke + endpoint tests for the lake-backed fundamentals-api FastAPI app (epic Task 10).

Asserts: the app builds; `/health` answers `ok`; the prefix-aliased admin health is reachable; the
internal seam path + the headline `/pit` path serve the byte-compatible PIT payload (driven via a patched
resolver over a SYNTHETIC lake, no live Timescale/Redis); the not-yet-normalized-name path (empty but
200 — the legitimate state while the harvester bootstraps); `/coverage` reports the lake's covered-CIK
count; `/quarantine` is GONE (404 — decision D); and the ingress-prefix / contract invariants. Exercised
against the in-process app via the Starlette test client.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import src.main as main
from src.main import SERVICE_NAME, app
from src.resolver import FundamentalsResolver
from tests.fakes import (
    FakeMarketDataReader,
    entity_row,
    full_name_facts,
    ms,
    ticker_row,
    write_entities,
    write_facts,
    write_ticker_history,
)

from quant_core.fundamentals.lake.store import Store

client = TestClient(app)

CIK_FULL = 100
AS_OF = ms(2024, 6, 1)


@pytest.fixture()
def lake(tmp_path: Path) -> Path:
    """A one-name synthetic lake (a fully-covered US software name)."""
    root = tmp_path / "lake"
    root.mkdir()
    write_facts(root, CIK_FULL, full_name_facts(CIK_FULL))
    write_ticker_history(root, [ticker_row(CIK_FULL, "AAPL")])
    write_entities(root, [entity_row(CIK_FULL, "AAPL")])
    return root


def _patch_resolver(monkeypatch, lake: Path, market_data=None) -> None:
    """Patch the app's resolver factory to hand handlers a resolver over a real lake Store (no live
    Timescale/Redis); cache disabled. `market_data` optionally injects the Gap-2 reader."""

    async def _fake_build():
        return FundamentalsResolver(Store(lake), redis=None, market_data=market_data)

    monkeypatch.setattr(main, "_build_resolver", _fake_build)


def _patch_lake_dir(monkeypatch, lake: Path) -> None:
    """Point the /coverage handler's `lake_dir()` at the synthetic lake."""
    monkeypatch.setattr("src.store.lake_dir", lambda: str(lake))


# ── health ───────────────────────────────────────────────────────────────────────
def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"
    assert res.json()["service"] == SERVICE_NAME


def test_admin_aliased_health_ok() -> None:
    res = client.get("/admin/api/fundamentals-pit/health")
    assert res.status_code == 200
    assert res.json()["service"] == SERVICE_NAME


def test_metrics_exposes_prometheus() -> None:
    client.get("/health")  # drive one request so the histogram has a sample
    res = client.get("/metrics")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    body = res.text
    assert "fundamentals_api_up 1.0" in body
    assert "fundamentals_api_request_duration_seconds_bucket" in body


def test_metrics_unmatched_path_uses_stable_label() -> None:
    client.get("/this/path/does/not/exist/abc123")
    body = client.get("/metrics").text
    assert 'route="<unmatched>"' in body
    assert "abc123" not in body  # the raw path never leaks into a label


# ── internal seam hot path ─────────────────────────────────────────────────────────
def test_internal_fundamentals_returns_pit_payload(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake)
    res = client.get(f"/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={AS_OF}")
    assert res.status_code == 200
    body = res.json()
    aapl = body["fundamentals"]["AAPL_US_EQ"]
    assert aapl["net_income"] == 110.0
    assert aapl["source"] == "pit-edgar"
    assert aapl["knowledge_ts"] is not None
    assert body["asOf"] == AS_OF


def test_internal_fundamentals_empty_but_200_for_uncovered(monkeypatch, lake: Path) -> None:
    # A name not in the lake (or not yet normalized while the harvester bootstraps) returns an empty
    # per-name dict with a 200 — NOT a 500. This is the graceful-empty path QA hits on a filling lake.
    _patch_resolver(monkeypatch, lake)
    res = client.get(f"/internal/api/fundamentals-pit?tickers=ZZZZ_US_EQ&asOf={AS_OF}")
    assert res.status_code == 200
    zz = res.json()["fundamentals"]["ZZZZ_US_EQ"]
    assert "net_income" not in zz
    assert zz["source"] is None
    assert zz["observation_ts"] is None


def test_internal_fundamentals_non_us_is_empty(monkeypatch, lake: Path) -> None:
    # A non-US name → {} fail-closed (no Yahoo, no error).
    _patch_resolver(monkeypatch, lake)
    res = client.get(f"/internal/api/fundamentals-pit?tickers=SHELl_EQ&asOf={AS_OF}")
    assert res.status_code == 200
    shel = res.json()["fundamentals"]["SHELl_EQ"]
    assert shel["source"] is None
    assert "net_income" not in shel


def test_internal_fundamentals_no_tickers_is_empty(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake)
    res = client.get("/internal/api/fundamentals-pit")
    assert res.status_code == 200
    assert res.json()["fundamentals"] == {}


# ── headline /pit path ──────────────────────────────────────────────────────────────
def test_admin_pit_headline_resolves(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake)
    res = client.get(f"/admin/api/fundamentals-pit/pit?symbols=AAPL_US_EQ&as_of={AS_OF}")
    assert res.status_code == 200
    aapl = res.json()["fundamentals"]["AAPL_US_EQ"]
    assert aapl["net_income"] == 110.0


def test_admin_pit_accepts_bare_symbol(monkeypatch, lake: Path) -> None:
    # The seam accepts a bare symbol too (transition-safe).
    _patch_resolver(monkeypatch, lake)
    res = client.get(f"/admin/api/fundamentals-pit/pit?symbols=AAPL&as_of={AS_OF}")
    assert res.status_code == 200
    assert res.json()["fundamentals"]["AAPL"]["net_income"] == 110.0


# ── coverage from the lake ──────────────────────────────────────────────────────────
def test_coverage_counts_covered_ciks(monkeypatch, lake: Path) -> None:
    _patch_lake_dir(monkeypatch, lake)
    res = client.get("/admin/api/fundamentals-pit/coverage")
    assert res.status_code == 200
    body = res.json()
    assert body["instruments"] == 1          # one facts/cik=*.parquet file
    assert body["entities_present"] is True
    assert body["oldest_observation_ts"] is None  # deep scan is the harvester /freshness surface


def test_coverage_cold_lake_is_200_zero(monkeypatch, tmp_path: Path) -> None:
    cold = tmp_path / "cold"
    cold.mkdir()  # no facts/ dir at all (harvester hasn't bootstrapped)
    monkeypatch.setattr("src.store.lake_dir", lambda: str(cold))
    res = client.get("/admin/api/fundamentals-pit/coverage")
    assert res.status_code == 200
    body = res.json()
    assert body["instruments"] == 0
    assert body["entities_present"] is False


# ── quarantine is GONE (decision D) ─────────────────────────────────────────────────
def test_quarantine_route_removed_404() -> None:
    # The quarantine surface was removed in the lake rewrite (no quarantine in the lake design).
    res = client.get("/admin/api/fundamentals-pit/quarantine")
    assert res.status_code == 404


def test_quarantine_not_registered() -> None:
    paths = {r.path for r in app.routes}
    assert "/admin/api/fundamentals-pit/quarantine" not in paths


# ── Gap-2: market cap surfaced in the seam payload + the /factors endpoint ──────────
def _seeded_md() -> FakeMarketDataReader:
    md = FakeMarketDataReader()
    md.set_close("AAPL_US_EQ", AS_OF, 30.0)
    md.set_fx("USD", 0.79)
    md.set_dividend_yield("AAPL_US_EQ", 0.0055)
    return md


def test_internal_seam_payload_includes_computed_market_cap(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake, market_data=_seeded_md())
    res = client.get(f"/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={AS_OF}")
    assert res.status_code == 200
    aapl = res.json()["fundamentals"]["AAPL_US_EQ"]
    assert aapl["market_cap_gbp"] == 30.0 * 50.0 * 0.79
    assert aapl["dividend_yield"] == 0.0055


def test_factors_endpoint_returns_value_quality_legs(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake, market_data=_seeded_md())
    res = client.get(f"/admin/api/fundamentals-pit/factors?universe=AAPL_US_EQ&as_of={AS_OF}")
    assert res.status_code == 200
    body = res.json()
    entry = body["factors"]["AAPL_US_EQ"]
    f = entry["factors"]
    market_cap = 30.0 * 50.0 * 0.79
    assert f["earnings_yield"] == 110.0 / market_cap
    assert f["book_to_market"] == 500.0 / market_cap
    assert f["roe"] == 110.0 / 500.0
    assert f["dividend_yield"] == 0.0055
    assert entry["source"] == "pit-edgar"
    assert body["count"] == 1


def test_factors_endpoint_empty_but_200_for_uncovered(monkeypatch, lake: Path) -> None:
    # A name not in the lake → 200 with its factors all null, not a 500.
    _patch_resolver(monkeypatch, lake, market_data=FakeMarketDataReader())
    res = client.get("/admin/api/fundamentals-pit/factors?universe=ZZZZ_US_EQ")
    assert res.status_code == 200
    f = res.json()["factors"]["ZZZZ_US_EQ"]["factors"]
    assert f["roe"] is None
    assert f["earnings_yield"] is None


def test_factors_endpoint_no_universe_is_empty(monkeypatch, lake: Path) -> None:
    _patch_resolver(monkeypatch, lake, market_data=FakeMarketDataReader())
    res = client.get("/admin/api/fundamentals-pit/factors")
    assert res.status_code == 200
    assert res.json()["factors"] == {}
