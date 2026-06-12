"""Endpoint tests for the harvester's thin FastAPI status surface (epic Task 9).

No network: a FastAPI `TestClient` drives the routes over a tmp fixture lake built with the harvester's own
writers. The EDGAR client is never constructed (the read routes don't touch it, and force-sweep is not
exercised here — it would fail closed without a real EDGAR_USER_AGENT, by design). The app reads its lake
path from a module-level `LAKE`, so each test points it at the fixture via monkeypatch.

Asserts the routes return well-formed JSON with the documented keys — `/status`, `/config`, `/freshness`,
`/runs` — and that `/quarantine` is 404 (decision D: the lake design has no quarantine).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient

import app as app_mod
import identity
import normalize

NOW = datetime(2026, 6, 12, tzinfo=timezone.utc)


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A TestClient whose app reads the tmp fixture lake."""
    monkeypatch.setattr(app_mod, "LAKE", tmp_path)
    return TestClient(app_mod.app)


def _fact(*, end: str, filed: str, form: str, fp: str) -> dict:
    return {
        "start": "2020-01-01",
        "end": end,
        "val": 1.0,
        "fy": int(end[:4]),
        "fp": fp,
        "form": form,
        "accn": f"{form}-{end}-{filed}",
        "filed": filed,
        "frame": None,
    }


def _seed_covered_name(lake, cik: int, ticker: str) -> None:
    """Open a ticker→CIK range + write one covered 10-Q fact, so /status + /freshness have real data."""
    identity.snapshot_tickers(lake, {0: {"ticker": ticker, "cik_str": cik}}, today=NOW.date())
    normalize.write_company_facts(
        lake,
        {"cik": cik, "facts": {"us-gaap": {"Revenues": {"units": {"USD": [
            _fact(end="2026-03-31", filed="2026-04-30", form="10-Q", fp="Q1"),
        ]}}}}},
        None,
    )


# --------------------------------------------------------------------------- #
# /status                                                                     #
# --------------------------------------------------------------------------- #
def test_status_cold_lake(client) -> None:
    """A cold lake: bootstrap not complete, zero covered CIKs, no last sweep — well-formed, 200."""
    r = client.get("/admin/api/fundamentals-ingest/status")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "fundamentals-harvester"
    assert body["bootstrap_complete"] is False
    assert body["bootstrap"] is None
    assert body["covered_ciks"] == 0
    assert body["last_sweep_date"] is None
    assert body["lake_size_bytes"] == 0
    assert body["has_ticker_history"] is False
    assert body["has_entities"] is False


def test_status_after_bootstrap_and_facts(client, tmp_path) -> None:
    """With a sentinel + a covered CIK + a sweep ledger, /status reports them."""
    _seed_covered_name(tmp_path, 320193, "AAPL")
    (tmp_path / "bootstrap_complete.json").write_text(
        json.dumps({"completed_at": "2026-06-12T03:00:00+00:00", "entities": 1, "mode": "watchlist"})
    )
    (tmp_path / "harvester_state.json").write_text(json.dumps({"2026-06-11": [320193, 789019]}))
    body = client.get("/admin/api/fundamentals-ingest/status").json()
    assert body["bootstrap_complete"] is True
    assert body["bootstrap"]["mode"] == "watchlist"
    assert body["covered_ciks"] == 1
    assert body["last_sweep_date"] == "2026-06-11"
    assert body["last_sweep_ciks"] == 2
    assert body["lake_size_bytes"] > 0
    assert body["has_ticker_history"] is True


# --------------------------------------------------------------------------- #
# /config                                                                     #
# --------------------------------------------------------------------------- #
def test_config_reports_env_knobs(client, monkeypatch) -> None:
    monkeypatch.setenv("LAKE_DIR", "/srv/fundamentals-lake")
    monkeypatch.setenv("SWEEP_MINUTES", "45")
    monkeypatch.setenv("WATCHLIST", "AAPL, MSFT")
    monkeypatch.setenv("EDGAR_USER_AGENT", "trader-platform ops@example.com")
    body = client.get("/admin/api/fundamentals-ingest/config").json()
    assert body["lake_dir"] == "/srv/fundamentals-lake"
    assert body["sweep_minutes"] == 45
    assert body["watchlist"] == ["AAPL", "MSFT"]
    assert body["watchlist_mode"] is True
    assert body["edgar_user_agent_set"] is True


def test_config_ua_set_false_for_placeholder(client, monkeypatch) -> None:
    """A placeholder UA with no `@` contact reports `edgar_user_agent_set=False` (the fail-closed signal) —
    and the UA string itself is never echoed."""
    monkeypatch.setenv("EDGAR_USER_AGENT", "trader-platform fundamentals-harvester")  # no @
    monkeypatch.delenv("WATCHLIST", raising=False)
    body = client.get("/admin/api/fundamentals-ingest/config").json()
    assert body["edgar_user_agent_set"] is False
    assert body["watchlist_mode"] is False
    # The contact string is not surfaced anywhere in the config payload.
    assert "edgar_user_agent" not in body


# --------------------------------------------------------------------------- #
# /freshness                                                                   #
# --------------------------------------------------------------------------- #
def test_freshness_with_explicit_symbols(client, tmp_path) -> None:
    """/freshness?symbols=… audits the supplied universe — covered name present, missing name counted,
    NO_EDGAR name surfaced in its own block (never `missing`)."""
    _seed_covered_name(tmp_path, 320193, "AAPL")
    r = client.get("/admin/api/fundamentals-ingest/freshness", params={"symbols": "AAPL,NVDA,TCEHY"})
    assert r.status_code == 200
    body = r.json()
    # AAPL covered, NVDA missing; TCEHY excluded (no_edgar) -> eligible universe = 2.
    assert body["universe"] == 2
    assert body["covered"] == 1
    assert body["missing"] == 1
    assert body["no_edgar_count"] == 1
    assert body["no_edgar"][0]["symbol"] == "TCEHY"
    syms = {n["symbol"] for n in body["names"]}
    assert syms == {"AAPL", "NVDA"}  # TCEHY not a per-name row
    assert body["retirable"] is False  # NVDA missing


def test_freshness_default_universe_from_lake(client, tmp_path) -> None:
    """/freshness with no symbols defaults to the lake's currently-listed tickers (no Mongo read)."""
    _seed_covered_name(tmp_path, 320193, "AAPL")
    body = client.get("/admin/api/fundamentals-ingest/freshness").json()
    assert {n["symbol"] for n in body["names"]} == {"AAPL"}
    assert body["universe"] == 1


def test_freshness_cold_lake_well_formed(client) -> None:
    """/freshness over a cold lake (default universe) → empty, well-formed, 200 (not an error)."""
    r = client.get("/admin/api/fundamentals-ingest/freshness")
    assert r.status_code == 200
    body = r.json()
    assert body["universe"] == 0
    assert body["names"] == []
    assert body["no_edgar"] == []


# --------------------------------------------------------------------------- #
# /runs                                                                        #
# --------------------------------------------------------------------------- #
def test_runs_from_sweep_ledger(client, tmp_path) -> None:
    """/runs returns recent sweep history newest-first from harvester_state.json."""
    (tmp_path / "harvester_state.json").write_text(
        json.dumps({"2026-06-10": [1, 2], "2026-06-11": [3, 4, 5], "2026-06-12": [6]})
    )
    body = client.get("/admin/api/fundamentals-ingest/runs").json()
    assert body["count"] == 3
    # Newest-first.
    assert body["runs"][0] == {"date": "2026-06-12", "ciks": 1}
    assert body["runs"][1] == {"date": "2026-06-11", "ciks": 3}
    assert body["runs"][2] == {"date": "2026-06-10", "ciks": 2}


def test_runs_empty_on_cold_lake(client) -> None:
    body = client.get("/admin/api/fundamentals-ingest/runs").json()
    assert body == {"runs": [], "count": 0}


def test_runs_limit_bounds_rows(client, tmp_path) -> None:
    (tmp_path / "harvester_state.json").write_text(
        json.dumps({f"2026-06-{d:02d}": [1] for d in range(1, 6)})
    )
    body = client.get("/admin/api/fundamentals-ingest/runs", params={"limit": 2}).json()
    assert body["count"] == 2


# --------------------------------------------------------------------------- #
# /quarantine is GONE (decision D)                                            #
# --------------------------------------------------------------------------- #
def test_quarantine_route_absent(client) -> None:
    """Decision D: the lake design drops QA/quarantine — the route is not mounted (404)."""
    assert client.get("/admin/api/fundamentals-ingest/quarantine").status_code == 404


# --------------------------------------------------------------------------- #
# /health                                                                      #
# --------------------------------------------------------------------------- #
def test_health_ok(client) -> None:
    assert client.get("/health").json() == {"status": "ok", "service": "fundamentals-harvester"}
    aliased = client.get("/admin/api/fundamentals-ingest/health")
    assert aliased.status_code == 200
    assert aliased.json()["status"] == "ok"
