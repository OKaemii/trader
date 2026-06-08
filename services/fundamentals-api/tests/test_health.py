"""Smoke + endpoint tests for the fundamentals-api FastAPI app (epic Task 11).

Asserts: the app builds; `/health` answers `ok` with the service name; the prefix-aliased admin health is
reachable; the internal seam path + the headline `/pit` path serve the PIT-resolved payload (driven via a
patched resolver over the FakeTimescale, no live Timescale/Redis); the EMPTY-but-200 live path (no rows
seeded — the legitimate state until the operator runs the Task-9 backfill); and the ingress-prefix /
contract invariants the next cards depend on. Exercised against the in-process app via the Starlette test
client.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import src.main as main
from src.main import SERVICE_NAME, app
from src.resolver import FundamentalsResolver
from src.security_master import SecurityMasterResolver
from tests.fakes import FakeMarketDataReader, FakeTimescale

client = TestClient(app)

_T2018 = 1_500_000_000_000
_KNOW = 1_580_000_000_000
_AS_OF = 1_600_000_000_000


def _patch_resolver(monkeypatch, db: FakeTimescale, market_data=None) -> None:
    """Patch the app's resolver factory to hand handlers a resolver over the in-memory db (no real
    Timescale/Redis); cache disabled (redis=None). `market_data` optionally injects the Gap-2
    market-cap/dividend reader (a FakeMarketDataReader) so the enrichment path is exercised through the
    app with no HTTP."""

    async def _fake_build():
        return FundamentalsResolver(db, SecurityMasterResolver(db), redis=None, market_data=market_data)

    monkeypatch.setattr(main, "_build_resolver", _fake_build)


# ── health ───────────────────────────────────────────────────────────────────────
def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == SERVICE_NAME


def test_admin_aliased_health_ok() -> None:
    res = client.get("/admin/api/fundamentals-pit/health")
    assert res.status_code == 200
    assert res.json()["service"] == SERVICE_NAME


# ── internal seam hot path ─────────────────────────────────────────────────────────
def test_internal_fundamentals_returns_pit_payload(monkeypatch) -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW, value=100.0)
    _patch_resolver(monkeypatch, db)

    res = client.get(f"/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={_AS_OF}")
    assert res.status_code == 200
    body = res.json()
    aapl = body["fundamentals"]["AAPL_US_EQ"]
    assert aapl["net_income"] == 100.0
    assert aapl["source"] == "pit-edgar"
    assert aapl["knowledge_ts"] == _KNOW
    assert body["asOf"] == _AS_OF


def test_internal_fundamentals_empty_but_200_live(monkeypatch) -> None:
    # The cluster has no fundamentals rows until the operator runs the Task-9 backfill, so a live read
    # legitimately returns an empty per-name dict with a 200 — NOT a 500. This is the exact path QA hits.
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")  # resolves, but no facts
    _patch_resolver(monkeypatch, db)
    res = client.get("/internal/api/fundamentals-pit?tickers=AAPL_US_EQ")  # no asOf ⇒ live
    assert res.status_code == 200
    body = res.json()
    aapl = body["fundamentals"]["AAPL_US_EQ"]
    # No facts → the line-item keys are simply absent (never a fabricated 0), and the provenance is null.
    assert "net_income" not in aapl
    assert aapl["source"] is None
    assert aapl["observation_ts"] is None


def test_internal_fundamentals_no_tickers_is_empty(monkeypatch) -> None:
    db = FakeTimescale()
    _patch_resolver(monkeypatch, db)
    res = client.get("/internal/api/fundamentals-pit")
    assert res.status_code == 200
    assert res.json()["fundamentals"] == {}


# ── headline /pit path ──────────────────────────────────────────────────────────────
def test_admin_pit_headline_no_look_ahead(monkeypatch) -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    # A fact knowable before the asOf and one only after it.
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW, value=100.0)
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018 + 1,
                knowledge_ts=_AS_OF + 5_000_000_000, value=999.0)  # accepted after as_of
    _patch_resolver(monkeypatch, db)

    res = client.get(f"/admin/api/fundamentals-pit/pit?symbols=AAPL_US_EQ&as_of={_AS_OF}")
    assert res.status_code == 200
    aapl = res.json()["fundamentals"]["AAPL_US_EQ"]
    assert aapl["net_income"] == 100.0  # the post-as_of fact (999.0) is NOT visible — no look-ahead


# ── coverage / quarantine endpoints ────────────────────────────────────────────────
def test_coverage_empty_warehouse_is_200_zero(monkeypatch) -> None:
    db = FakeTimescale()

    async def _fake_get_pool():
        return db

    monkeypatch.setattr("src.pool.get_pool", _fake_get_pool)
    res = client.get("/admin/api/fundamentals-pit/coverage")
    assert res.status_code == 200
    body = res.json()
    assert body["instruments"] == 0
    assert body["facts"] == 0
    assert body["oldest_observation_ts"] is None


def test_coverage_counts_current_facts(monkeypatch) -> None:
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018,
                knowledge_ts=_KNOW, value=100.0)
    db.add_fact(instrument_id=10, metric="total_equity", observation_ts=_T2018,
                knowledge_ts=_KNOW, value=500.0, is_superseded=True)  # superseded — not counted

    async def _fake_get_pool():
        return db

    monkeypatch.setattr("src.pool.get_pool", _fake_get_pool)
    res = client.get("/admin/api/fundamentals-pit/coverage")
    assert res.status_code == 200
    body = res.json()
    assert body["instruments"] == 1
    assert body["facts"] == 1  # only the current (is_superseded=FALSE) row


def test_quarantine_reports_by_reason(monkeypatch) -> None:
    db = FakeTimescale()
    db.fundamentals_quarantine.append({
        "event_id": 1, "occurred_at": None, "instrument_id": None, "filing_id": None,
        "reason": "value_disagreement", "payload": {"check": "value_agreement"},
    })

    async def _fake_get_pool():
        return db

    monkeypatch.setattr("src.pool.get_pool", _fake_get_pool)
    res = client.get("/admin/api/fundamentals-pit/quarantine")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 1
    assert body["by_reason"] == {"value_disagreement": 1}


def test_coverage_degrades_to_503_on_db_error(monkeypatch) -> None:
    async def _boom():
        raise OSError("timescale unreachable")

    monkeypatch.setattr("src.pool.get_pool", _boom)
    res = client.get("/admin/api/fundamentals-pit/coverage")
    assert res.status_code == 503
    assert "detail" in res.json()


# ── Gap-2: market cap surfaced in the seam payload + the /factors endpoint ──────────
def _seeded_db_md():
    """A db + market-data reader seeding one US name with the facts a PIT market cap + factors need."""
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    db.add_fact(instrument_id=10, metric="net_income", observation_ts=_T2018, knowledge_ts=_KNOW, value=100.0)
    db.add_fact(instrument_id=10, metric="total_equity", observation_ts=_T2018, knowledge_ts=_KNOW, value=500.0)
    db.add_fact(instrument_id=10, metric="shares_outstanding", observation_ts=_T2018,
                knowledge_ts=_KNOW, value=16.0)
    md = FakeMarketDataReader()
    md.set_close("AAPL_US_EQ", _AS_OF, 150.0)
    md.set_fx("USD", 0.79)
    md.set_dividend_yield("AAPL_US_EQ", 0.0055)
    return db, md


def test_internal_seam_payload_includes_computed_market_cap(monkeypatch) -> None:
    db, md = _seeded_db_md()
    _patch_resolver(monkeypatch, db, market_data=md)
    res = client.get(f"/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={_AS_OF}")
    assert res.status_code == 200
    aapl = res.json()["fundamentals"]["AAPL_US_EQ"]
    # market_cap_gbp is the computed PIT value (price×shares×fx), and the dividend_yield leg is present.
    assert aapl["market_cap_gbp"] == 150.0 * 16.0 * 0.79
    assert aapl["dividend_yield"] == 0.0055


def test_factors_endpoint_returns_value_quality_legs(monkeypatch) -> None:
    db, md = _seeded_db_md()
    _patch_resolver(monkeypatch, db, market_data=md)
    res = client.get(f"/admin/api/fundamentals-pit/factors?universe=AAPL_US_EQ&as_of={_AS_OF}")
    assert res.status_code == 200
    body = res.json()
    entry = body["factors"]["AAPL_US_EQ"]
    f = entry["factors"]
    market_cap = 150.0 * 16.0 * 0.79
    # Value legs computed on the COMPUTED PIT market cap; ROE on equity. Matches the live factor math.
    assert f["earnings_yield"] == 100.0 / market_cap
    assert f["book_to_market"] == 500.0 / market_cap
    assert f["roe"] == 100.0 / 500.0
    assert f["dividend_yield"] == 0.0055
    assert entry["source"] == "pit-edgar"
    assert body["count"] == 1


def test_factors_endpoint_empty_but_200_live(monkeypatch) -> None:
    # No rows seeded (the pre-backfill cluster state) → 200 with the name's factors all null, not a 500.
    db = FakeTimescale()
    db.add_instrument(instrument_id=10, t212_ticker="AAPL_US_EQ")
    md = FakeMarketDataReader()
    _patch_resolver(monkeypatch, db, market_data=md)
    res = client.get("/admin/api/fundamentals-pit/factors?universe=AAPL_US_EQ")  # no as_of ⇒ live
    assert res.status_code == 200
    f = res.json()["factors"]["AAPL_US_EQ"]["factors"]
    assert f["roe"] is None
    assert f["earnings_yield"] is None


def test_factors_endpoint_no_universe_is_empty(monkeypatch) -> None:
    db = FakeTimescale()
    _patch_resolver(monkeypatch, db, market_data=FakeMarketDataReader())
    res = client.get("/admin/api/fundamentals-pit/factors")
    assert res.status_code == 200
    assert res.json()["factors"] == {}
