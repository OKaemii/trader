"""Smoke tests for the fundamentals-ingestion FastAPI app.

The skeleton's contract for epic Task 3 is exactly: the app builds, `/health` answers `ok` with the
service name, the prefix-aliased admin health is reachable, and the admin ingest trigger ACCEPTS a
request without running the (not-yet-wired) pipeline inline. These assertions are what the QA
"`/health` returns 200 in the image" gate proves, exercised here against the in-process app via the
Starlette test client (no Mongo/Timescale connection needed — the skeleton opens none)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from src.main import SERVICE_NAME, app

client = TestClient(app)


def test_health_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == SERVICE_NAME


def test_admin_aliased_health_ok() -> None:
    # The bare /health is not reachable through the admin ingress (nginx routes by prefix only); the
    # aliased path under the admin prefix is the one the portal fan-out hits.
    res = client.get("/admin/api/fundamentals-ingest/health")
    assert res.status_code == 200
    assert res.json()["service"] == SERVICE_NAME


def test_metrics_exposes_prometheus() -> None:
    # The write-side ServiceMonitor scrapes /metrics (epic Task 20): a Prometheus exposition carrying the
    # liveness gauge, and — after a request flows through the latency middleware — the request-duration
    # histogram. text/plain exposition, 200, no auth (cluster-internal scrape).
    client.get("/health")  # drive one request so the histogram has a sample
    res = client.get("/metrics")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/plain")
    body = res.text
    assert "fundamentals_ingestion_up 1.0" in body
    assert "fundamentals_ingestion_request_duration_seconds_bucket" in body


def test_trigger_ingest_accepts_without_running() -> None:
    # SKELETON behaviour: the trigger only acknowledges intent. It must NOT block on a multi-minute
    # pipeline, and it reports the scope it would run.
    res = client.post("/admin/api/fundamentals-ingest", json={"tickers": ["AAPL_US_EQ", "MSFT_US_EQ"]})
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] is True
    assert body["service"] == SERVICE_NAME
    assert body["scope"] == "subset"
    assert body["ticker_count"] == 2


def test_trigger_ingest_defaults_to_full_coverage() -> None:
    res = client.post("/admin/api/fundamentals-ingest", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] is True
    assert body["scope"] == "all"
    assert body["ticker_count"] is None
    assert body["full"] is False


# ── QA quarantine report endpoint (epic Task 8) ───────────────────────────────────
def test_quarantine_report_serves_summary(monkeypatch) -> None:
    # The admin QA report (under the Task-3 ingress prefix) returns the aggregated quarantine summary.
    # Patch the pool factory to hand the handler the in-memory FakeTimescale (no real Timescale), seeded
    # with one quarantine row, and assert the endpoint serialises the report.
    import json as _json

    from src.qa.checks import REASON_OUTLIER
    from tests.fakes import FakeTimescale

    db = FakeTimescale()
    db.fundamentals_quarantine.append({
        "event_id": db._next("quarantine"), "occurred_at": db._seq["quarantine"],
        "instrument_id": None, "filing_id": None, "reason": REASON_OUTLIER,
        "payload": _json.dumps({"check": "period_ratio", "metric": "total_revenue"}),
    })

    async def _fake_get_pool(*_a, **_k):
        return db

    monkeypatch.setattr("src.security_master.pool.get_pool", _fake_get_pool)
    res = client.get("/admin/api/fundamentals-ingest/quarantine")
    assert res.status_code == 200
    body = res.json()
    assert body["total"] == 1
    assert body["by_reason"] == {REASON_OUTLIER: 1}
    assert body["recent"][0]["payload"]["metric"] == "total_revenue"


def test_quarantine_report_degrades_to_503_on_db_error(monkeypatch) -> None:
    # A Timescale-unreachable error must surface as a JSON 503 (a read over a possibly-cold warehouse),
    # never an unhandled 500 — and /health stays independent of the warehouse being up.
    async def _boom(*_a, **_k):
        raise OSError("timescale unreachable")

    monkeypatch.setattr("src.security_master.pool.get_pool", _boom)
    res = client.get("/admin/api/fundamentals-ingest/quarantine")
    assert res.status_code == 503
    assert "detail" in res.json()
