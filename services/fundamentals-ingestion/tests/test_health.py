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


# ── force-ingest trigger (Ops backend card): now a REAL single-flight run ──────────
# A fake run store so the trigger endpoints are exercised without Mongo/Timescale/EDGAR — the real
# IngestRunStore is unit-tested in test_run_store.py; here we only assert the HTTP contract.
class _FakeRecord:
    def __init__(self, run_id="run-1", state="running", scope="all"):
        self.run_id = run_id
        self._state = state
        self._scope = scope

    def to_payload(self):
        return {"run_id": self.run_id, "state": self._state, "scope": self._scope}


class _FakeRunStore:
    def __init__(self, *, started=True, record=None):
        self._started = started
        self._record = record or _FakeRecord()
        self.start_calls: list[list | None] = []

    async def start(self, *, tickers=None, cap=None):  # noqa: ARG002
        self.start_calls.append(tickers)
        scope = "subset" if tickers else "all"
        return _FakeRecord(scope=scope), self._started

    def get(self, run_id):
        return self._record if run_id == self._record.run_id else None

    def latest(self):
        return self._record


def test_trigger_ingest_starts_real_run_and_returns_run_id(monkeypatch) -> None:
    # The trigger now STARTS a single-flight background run and returns immediately with a run id; the
    # historical accept-shape keys are preserved so the portal contract is stable.
    store = _FakeRunStore()
    monkeypatch.setattr("src.main.get_run_store", lambda: store)
    res = client.post("/admin/api/fundamentals-ingest", json={"tickers": ["AAPL_US_EQ", "MSFT_US_EQ"]})
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] is True
    assert body["service"] == SERVICE_NAME
    assert body["scope"] == "subset"
    assert body["ticker_count"] == 2
    assert body["started"] is True
    assert body["run"]["run_id"] == "run-1"
    assert store.start_calls == [["AAPL_US_EQ", "MSFT_US_EQ"]]


def test_trigger_ingest_defaults_to_full_coverage(monkeypatch) -> None:
    store = _FakeRunStore()
    monkeypatch.setattr("src.main.get_run_store", lambda: store)
    res = client.post("/admin/api/fundamentals-ingest", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["accepted"] is True
    assert body["scope"] == "all"
    assert body["ticker_count"] is None
    assert body["full"] is False
    assert store.start_calls == [None]


def test_force_ingest_endpoint_returns_run_id(monkeypatch) -> None:
    store = _FakeRunStore()
    monkeypatch.setattr("src.main.get_run_store", lambda: store)
    res = client.post("/admin/api/fundamentals-ingest/force", json={})
    assert res.status_code == 200
    body = res.json()
    assert body["started"] is True
    assert body["run_id"] == "run-1"


def test_force_ingest_single_flight_reports_not_started(monkeypatch) -> None:
    store = _FakeRunStore(started=False)
    monkeypatch.setattr("src.main.get_run_store", lambda: store)
    res = client.post("/admin/api/fundamentals-ingest/force", json={})
    assert res.status_code == 200
    assert res.json()["started"] is False  # a concurrent trigger is a no-op accept, not an error


def test_get_run_by_id(monkeypatch) -> None:
    store = _FakeRunStore(record=_FakeRecord(run_id="run-42", state="done"))
    monkeypatch.setattr("src.main.get_run_store", lambda: store)
    ok = client.get("/admin/api/fundamentals-ingest/runs/run-42")
    assert ok.status_code == 200 and ok.json()["state"] == "done"
    missing = client.get("/admin/api/fundamentals-ingest/runs/nope")
    assert missing.status_code == 404


# ── portal_fundamentals_config GET/PUT (Ops backend card) ──────────────────────────
class _FakeConfigProvider:
    def __init__(self):
        from src.config import resolve_effective
        self._doc: dict = {}
        self._resolve = resolve_effective
        self.put_patches: list[dict] = []

    async def get(self, *, force_refresh=False):  # noqa: ARG002
        return self._resolve(self._doc)

    async def put(self, patch, *, updated_by="portal"):  # noqa: ARG002
        self.put_patches.append(patch)
        self._doc.update({k: v for k, v in patch.items()})
        return self._resolve(self._doc)


def test_get_config_returns_effective(monkeypatch) -> None:
    monkeypatch.delenv("EDGAR_USER_AGENT", raising=False)
    monkeypatch.setattr("src.main.get_config_provider", _FakeConfigProvider)
    res = client.get("/admin/api/fundamentals-ingest/config")
    assert res.status_code == 200
    body = res.json()
    # No override/env → built-in default, usable.
    assert body["edgarUserAgentSource"] == "default"
    assert body["edgarUserAgentUsable"] is True
    assert body["ingestEnabled"] is True


def test_put_config_updates_and_returns_effective(monkeypatch) -> None:
    provider = _FakeConfigProvider()
    monkeypatch.setattr("src.main.get_config_provider", lambda: provider)
    res = client.put(
        "/admin/api/fundamentals-ingest/config",
        json={"edgarUserAgent": "portal-ua portal@example.com", "coverageCap": 8},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["updated"] is True
    assert body["edgarUserAgent"] == "portal-ua portal@example.com"
    assert body["edgarUserAgentSource"] == "override"
    assert body["coverageCap"] == 8
    # Only explicitly-set fields are forwarded to the provider patch.
    assert provider.put_patches == [{"edgarUserAgent": "portal-ua portal@example.com", "coverageCap": 8}]


def test_put_config_omits_unset_fields(monkeypatch) -> None:
    # An omitted field is NOT forwarded (per-field fall-back); only edgarUserAgent is in the patch.
    provider = _FakeConfigProvider()
    monkeypatch.setattr("src.main.get_config_provider", lambda: provider)
    client.put(
        "/admin/api/fundamentals-ingest/config", json={"edgarUserAgent": "ua only@example.com"}
    )
    assert provider.put_patches == [{"edgarUserAgent": "ua only@example.com"}]


# ── status aggregation endpoint (Ops backend card) ─────────────────────────────────
def test_status_endpoint_aggregates(monkeypatch) -> None:
    from tests.test_status import _CoverageFakeTimescale

    db = _CoverageFakeTimescale()
    db.fundamentals.append({
        "instrument_id": 1, "metric": "net_income", "observation_ts": 1_000, "knowledge_ts": 5_000,
        "dim_signature": "", "value": 1.0, "is_superseded": False, "content_hash": "h",
        "source": "pit-edgar",
    })

    async def _fake_get_pool(*_a, **_k):
        return db

    monkeypatch.setattr("src.main.get_config_provider", _FakeConfigProvider)
    monkeypatch.setattr("src.main.get_run_store", lambda: _FakeRunStore(record=_FakeRecord(state="done")))
    monkeypatch.setattr("src.security_master.pool.get_pool", _fake_get_pool)
    res = client.get("/admin/api/fundamentals-ingest/status")
    assert res.status_code == 200
    body = res.json()
    assert body["coverage"]["instruments"] == 1
    assert body["coverage"]["facts"] == 1
    assert "ingestion_lag_ms" in body
    assert body["last_run"]["state"] == "done"
    assert body["feed_health"]["edgar_user_agent_usable"] is True
    assert "quarantine" in body


def test_status_degrades_to_503_on_db_error(monkeypatch) -> None:
    async def _boom(*_a, **_k):
        raise OSError("timescale unreachable")

    monkeypatch.setattr("src.main.get_config_provider", _FakeConfigProvider)
    monkeypatch.setattr("src.main.get_run_store", lambda: _FakeRunStore())
    monkeypatch.setattr("src.security_master.pool.get_pool", _boom)
    res = client.get("/admin/api/fundamentals-ingest/status")
    assert res.status_code == 503
    assert "detail" in res.json()


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
