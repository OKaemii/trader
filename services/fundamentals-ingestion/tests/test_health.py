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
