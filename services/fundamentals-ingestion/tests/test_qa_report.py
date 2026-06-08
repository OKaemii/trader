"""QA report tests — `quarantine_summary` aggregation + the per-name quarantine lookup (coverage-broaden Task 3).

Two layers, both over the in-memory `FakeTimescale` (no Postgres, no network):

  1. `quarantine_summary(...)` directly — proves the optional `instrument_id` filter scopes every count +
     the recent sample to a single name, that `instrument_id=None` is the byte-for-byte unfiltered
     aggregate (the predicate degrades to a SQL no-op), and that the applied scope is echoed back.

  2. the `GET /admin/api/fundamentals-ingest/quarantine` endpoint (via `TestClient`, the security-master
     pool monkeypatched to the fake) — proves the `?symbol=` → `bare_us_symbol` → `resolve_symbol` →
     instrument_id resolution, that a directly-passed `?instrument_id=` wins, and the headline honesty
     contract: an unknown or non-US `?symbol=` returns an EMPTY summary with `resolved:false` (the
     unmatchable sentinel), never the full unfiltered set (which card #149's per-name UI consumes).

The base `FakeTimescale` already reproduces the three quarantine query shapes (by-reason / by-sector /
recent sample), updated alongside the SUT to honour the new `$2 instrument_id` bind.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.qa.checks import REASON_IDENTITY_BREAK, REASON_MISSING_DATA, REASON_OUTLIER
from src.qa.report import quarantine_summary
from src.security_master.writers import (
    ID_TICKER,
    CompanyRecord,
    IdentifierRecord,
    InstrumentRecord,
    SecurityMasterWriter,
)
from tests.fakes import FakeTimescale


def _ms(year: int, month: int = 1, day: int = 1) -> int:
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


def _quarantine(db, *, instrument_id, reason, filing_id=None, payload=None):
    """Append one quarantine row the way the QA-engine writer would (BIGSERIAL event_id + a monotonic
    `occurred_at` surrogate so the recent-sample ordering is deterministic), so the report reads it back."""
    db.fundamentals_quarantine.append({
        "event_id": db._next("quarantine"),
        "occurred_at": db._seq["quarantine"],
        "instrument_id": instrument_id,
        "filing_id": filing_id,
        "reason": reason,
        "payload": json.dumps(payload if payload is not None else {"check": "fixture"}),
    })


# ── 1. quarantine_summary — the per-name filter ──────────────────────────────────────
@pytest.mark.asyncio
async def test_instrument_filter_scopes_to_a_single_name() -> None:
    db = FakeTimescale()
    # Instrument 1: two findings of distinct reasons. Instrument 2: one. A NULL-instrument row (a filing
    # that failed before resolution) — must NOT count toward any specific name.
    _quarantine(db, instrument_id=1, reason=REASON_IDENTITY_BREAK)
    _quarantine(db, instrument_id=1, reason=REASON_OUTLIER)
    _quarantine(db, instrument_id=2, reason=REASON_MISSING_DATA)
    _quarantine(db, instrument_id=None, reason=REASON_OUTLIER)

    scoped = await quarantine_summary(db, instrument_id=1)

    # Only instrument 1's two findings — the instrument-2 row and the NULL row are excluded.
    assert scoped["total"] == 2
    assert scoped["by_reason"] == {REASON_IDENTITY_BREAK: 1, REASON_OUTLIER: 1}
    assert all(r["instrument_id"] == 1 for r in scoped["recent"])
    # The applied scope is echoed back so the caller knows what it filtered on.
    assert scoped["instrument_id"] == 1


@pytest.mark.asyncio
async def test_instrument_filter_with_no_rows_is_honest_empty() -> None:
    db = FakeTimescale()
    _quarantine(db, instrument_id=1, reason=REASON_OUTLIER)

    # A real instrument with zero quarantine rows → empty counts, not a widened aggregate.
    empty = await quarantine_summary(db, instrument_id=999)
    assert empty["total"] == 0
    assert empty["by_reason"] == {}
    assert empty["by_sector"] == {}
    assert empty["recent"] == []
    assert empty["instrument_id"] == 999

    # The unmatchable sentinel the endpoint uses for an unknown symbol behaves the same — empty, scoped.
    sentinel = await quarantine_summary(db, instrument_id=-1)
    assert sentinel["total"] == 0
    assert sentinel["recent"] == []
    assert sentinel["instrument_id"] == -1


# ── 2. quarantine_summary — None is the unchanged aggregate ───────────────────────────
@pytest.mark.asyncio
async def test_none_instrument_is_the_unfiltered_aggregate() -> None:
    db = FakeTimescale()
    _quarantine(db, instrument_id=1, reason=REASON_IDENTITY_BREAK)
    _quarantine(db, instrument_id=2, reason=REASON_OUTLIER)
    _quarantine(db, instrument_id=None, reason=REASON_OUTLIER)

    # The default call (no instrument_id) and an explicit instrument_id=None must agree, and must count
    # EVERY row across all names + the NULL-instrument row — byte-for-byte the pre-filter behaviour.
    default = await quarantine_summary(db)
    explicit_none = await quarantine_summary(db, instrument_id=None)

    assert default["total"] == 3
    assert default["by_reason"] == {REASON_OUTLIER: 2, REASON_IDENTITY_BREAK: 1}
    assert len(default["recent"]) == 3
    # The echo for the unfiltered path is null.
    assert default["instrument_id"] is None
    # The two unfiltered forms are identical (the predicate is a no-op when the scope is None).
    assert default == explicit_none


# ── 3. the endpoint — symbol resolution + the honesty contract ────────────────────────
def _patch_pool(monkeypatch, db: FakeTimescale) -> None:
    """Point the endpoint's lazily-imported `get_pool` at the fake. The handler does
    `from src.security_master.pool import get_pool` at call time, so patching the module attribute (the
    name the import re-binds each request) is what takes effect."""
    async def _fake_get_pool(*_args, **_kwargs):
        return db

    monkeypatch.setattr("src.security_master.pool.get_pool", _fake_get_pool)


def _seed_resolvable_instrument(db: FakeTimescale, *, t212_ticker: str, cik: str) -> int:
    """Land a company + instrument + a current ticker identifier interval via the real writer, so
    `SecurityMasterResolver.resolve_symbol(bare, now)` resolves the bare symbol to this instrument_id."""
    import asyncio

    async def _seed() -> int:
        writer = SecurityMasterWriter(db)
        company_id = await writer.upsert_company(
            CompanyRecord(name="Apple Inc.", country="US", cik=cik)
        )
        instrument_id = await writer.upsert_instrument(
            InstrumentRecord(company_id=company_id, instrument_type="common",
                             exchange="Nasdaq", currency="USD", t212_ticker=t212_ticker)
        )
        # An open-ended current ticker identifier interval (from listing) so the BARE symbol resolves
        # as-of "now" via `resolve_symbol` — a single appended row, no rename involved.
        await writer.append_identifier(
            IdentifierRecord(
                instrument_id=instrument_id, identifier_type=ID_TICKER,
                identifier_value="AAPL", effective_from=_ms(1980, 12, 12), effective_to=None,
            )
        )
        return instrument_id

    return asyncio.run(_seed())


def test_endpoint_symbol_resolves_and_scopes(monkeypatch) -> None:
    db = FakeTimescale()
    instrument_id = _seed_resolvable_instrument(db, t212_ticker="AAPL_US_EQ", cik="0000320193")
    _quarantine(db, instrument_id=instrument_id, reason=REASON_IDENTITY_BREAK)
    _quarantine(db, instrument_id=instrument_id, reason=REASON_OUTLIER)
    _quarantine(db, instrument_id=instrument_id + 99, reason=REASON_MISSING_DATA)  # a different name
    _patch_pool(monkeypatch, db)

    resp = TestClient(app).get("/admin/api/fundamentals-ingest/quarantine", params={"symbol": "AAPL_US_EQ"})
    assert resp.status_code == 200
    body = resp.json()
    # Resolved to AAPL's instrument_id, scoped to its two findings only.
    assert body["resolved"] is True
    assert body["symbol"] == "AAPL_US_EQ"
    assert body["instrument_id"] == instrument_id
    assert body["total"] == 2
    assert body["by_reason"] == {REASON_IDENTITY_BREAK: 1, REASON_OUTLIER: 1}


def test_endpoint_unknown_symbol_is_empty_and_unresolved(monkeypatch) -> None:
    db = FakeTimescale()
    # A populated queue, but the requested symbol was never ingested → no instrument identity.
    _quarantine(db, instrument_id=1, reason=REASON_OUTLIER)
    _quarantine(db, instrument_id=2, reason=REASON_MISSING_DATA)
    _patch_pool(monkeypatch, db)

    resp = TestClient(app).get("/admin/api/fundamentals-ingest/quarantine", params={"symbol": "NOTREAL"})
    assert resp.status_code == 200
    body = resp.json()
    # Honest empty (the unmatchable sentinel), explicitly flagged unresolved — NOT the full 2-row set.
    assert body["resolved"] is False
    assert body["symbol"] == "NOTREAL"
    assert body["instrument_id"] == -1
    assert body["total"] == 0
    assert body["by_reason"] == {}
    assert body["recent"] == []


def test_endpoint_non_us_symbol_is_empty_and_unresolved(monkeypatch) -> None:
    db = FakeTimescale()
    _quarantine(db, instrument_id=1, reason=REASON_OUTLIER)
    _patch_pool(monkeypatch, db)

    # A UK ticker has no US CIK — `bare_us_symbol` returns None, so it never even hits the resolver, and
    # the report is the same honest empty with resolved:false (the *_EQ UK suffix is out of EDGAR scope).
    resp = TestClient(app).get("/admin/api/fundamentals-ingest/quarantine", params={"symbol": "VODl_EQ"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["resolved"] is False
    assert body["instrument_id"] == -1
    assert body["total"] == 0


def test_endpoint_instrument_id_wins_over_symbol(monkeypatch) -> None:
    db = FakeTimescale()
    _quarantine(db, instrument_id=1, reason=REASON_IDENTITY_BREAK)
    _quarantine(db, instrument_id=2, reason=REASON_OUTLIER)
    _patch_pool(monkeypatch, db)

    # A direct instrument_id is authoritative; the bogus symbol alongside it is ignored (no resolution
    # attempted), and `resolved`/`symbol` are still surfaced because a symbol was supplied.
    resp = TestClient(app).get(
        "/admin/api/fundamentals-ingest/quarantine",
        params={"instrument_id": 2, "symbol": "IGNORED"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["instrument_id"] == 2
    assert body["total"] == 1
    assert body["by_reason"] == {REASON_OUTLIER: 1}


def test_endpoint_no_filter_omits_symbol_and_resolved_keys(monkeypatch) -> None:
    db = FakeTimescale()
    _quarantine(db, instrument_id=1, reason=REASON_OUTLIER)
    _quarantine(db, instrument_id=2, reason=REASON_MISSING_DATA)
    _patch_pool(monkeypatch, db)

    # No symbol and no instrument_id → the plain aggregate; the `symbol`/`resolved` keys are present ONLY
    # when a symbol was supplied, so a default call's shape is unchanged from before this task.
    resp = TestClient(app).get("/admin/api/fundamentals-ingest/quarantine")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["instrument_id"] is None
    assert "symbol" not in body
    assert "resolved" not in body
