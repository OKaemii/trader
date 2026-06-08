"""Append-only writer tests — companies/instruments/identifiers/filings.

Proves the writers (a) are idempotent on their natural keys so a backfill re-run does not duplicate
entities, (b) record a ticker rename as TWO appended identifier rows (prior already-closed) and never
an UPDATE, and (c) map tickers → country via the shared market router. Run against the in-memory
`FakeTimescale`, whose `run_execute` asserts on any UPDATE/DELETE — so an accidental in-place mutation
fails the suite (the append-only contract enforced in the test, mirroring the role-level grant)."""
from __future__ import annotations

import pytest

from src.security_master.writers import (
    COUNTRY_GB,
    COUNTRY_US,
    SOURCE_SEC_EDGAR,
    CompanyRecord,
    FilingRecord,
    IdentifierRecord,
    InstrumentRecord,
    SecurityMasterWriter,
    country_for_ticker,
)
from tests.fakes import FakeTimescale


@pytest.mark.asyncio
async def test_upsert_company_idempotent_by_cik() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    first = await w.upsert_company(CompanyRecord(name="Apple Inc.", country="US", cik="0000320193"))
    # Re-running with the same CIK (even a different display name) reuses the row, doesn't append.
    again = await w.upsert_company(CompanyRecord(name="APPLE INC", country="US", cik="0000320193"))
    assert first == again
    assert len(db.companies) == 1


@pytest.mark.asyncio
async def test_upsert_company_distinguishes_by_name_when_no_cik() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    a = await w.upsert_company(CompanyRecord(name="Acme A"))
    b = await w.upsert_company(CompanyRecord(name="Acme B"))
    a2 = await w.upsert_company(CompanyRecord(name="Acme A"))
    assert a != b
    assert a == a2
    assert len(db.companies) == 2


@pytest.mark.asyncio
async def test_upsert_company_writes_sector_on_insert() -> None:
    # A fresh company carries the SIC→QA template (general/bank/insurance/reit/utility) into the row on
    # the INSERT path, so quarantine by_sector buckets it immediately.
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Bank Co", cik="9", sector="bank"))
    assert db.companies[0]["company_id"] == cid
    assert db.companies[0]["sector"] == "bank"


@pytest.mark.asyncio
async def test_upsert_company_backfills_sector_on_found_path() -> None:
    # The retroactive backfill: a row first inserted WITHOUT a sector (the ~21 pre-existing rows) gains
    # one on a later re-ingest that supplies it — find-or-insert returns the SAME id, and the UPDATE
    # populates sector in place (the lone column-level mutation; never a duplicate row).
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    first = await w.upsert_company(CompanyRecord(name="Apple Inc.", cik="0000320193"))
    assert db.companies[0]["sector"] is None  # inserted sector-less
    again = await w.upsert_company(CompanyRecord(name="Apple Inc.", cik="0000320193", sector="general"))
    assert first == again
    assert len(db.companies) == 1                       # no duplicate issuer
    assert db.companies[0]["sector"] == "general"       # backfilled in place


@pytest.mark.asyncio
async def test_upsert_company_found_path_none_sector_leaves_row_unchanged() -> None:
    # A sector-less re-ingest must NOT clobber a stored sector with NULL — the non-null guard skips the
    # UPDATE entirely (so a caller that doesn't know the sector is harmless).
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Reit Co", cik="42", sector="reit"))
    again = await w.upsert_company(CompanyRecord(name="Reit Co", cik="42"))  # no sector
    assert cid == again
    assert db.companies[0]["sector"] == "reit"          # preserved, not nulled


@pytest.mark.asyncio
async def test_upsert_company_found_path_refreshes_changed_sector() -> None:
    # A reclassification (a filer's SIC band changed → a different template) is refreshed in place; the
    # IS DISTINCT FROM predicate means an UNCHANGED re-ingest is a no-op, but a genuine change lands.
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Co", cik="7", sector="general"))
    # Same sector again → no-op (the fake's IS DISTINCT FROM check leaves the value as-is).
    await w.upsert_company(CompanyRecord(name="Co", cik="7", sector="general"))
    assert db.companies[0]["sector"] == "general"
    # Changed sector → refreshed in place, still one row, same id.
    again = await w.upsert_company(CompanyRecord(name="Co", cik="7", sector="utility"))
    assert cid == again
    assert len(db.companies) == 1
    assert db.companies[0]["sector"] == "utility"


@pytest.mark.asyncio
async def test_upsert_instrument_idempotent_by_company_and_t212() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Co", cik="1"))
    i1 = await w.upsert_instrument(InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="X_US_EQ"))
    i2 = await w.upsert_instrument(InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="X_US_EQ"))
    assert i1 == i2
    assert len(db.instruments) == 1


@pytest.mark.asyncio
async def test_append_identifier_idempotent_on_exact_interval() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Co", cik="1"))
    iid = await w.upsert_instrument(InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="X_US_EQ"))
    rec = IdentifierRecord(instrument_id=iid, identifier_type="ticker", identifier_value="X",
                           effective_from=1000, effective_to=None)
    r1 = await w.append_identifier(rec)
    r2 = await w.append_identifier(rec)
    assert r1 == r2
    assert len(db.identifiers) == 1
    # A different effective_from is a genuinely distinct interval — appended, not collapsed.
    await w.append_identifier(IdentifierRecord(instrument_id=iid, identifier_type="ticker",
                                               identifier_value="X", effective_from=2000, effective_to=None))
    assert len(db.identifiers) == 2


@pytest.mark.asyncio
async def test_record_ticker_change_appends_two_rows_prior_closed() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Meta", cik="0001326801"))
    iid = await w.upsert_instrument(InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="META_US_EQ"))
    old_id, new_id = await w.record_ticker_change(
        iid, old_ticker="FB", new_ticker="META", changed_at_ms=5000, old_effective_from=100,
    )
    assert old_id != new_id
    assert len(db.identifiers) == 2
    fb = next(r for r in db.identifiers if r["identifier_value"] == "FB")
    meta = next(r for r in db.identifiers if r["identifier_value"] == "META")
    # Prior row is inserted ALREADY closed at the change instant; new row is open from it.
    assert fb["effective_from"] == 100 and fb["effective_to"] == 5000
    assert meta["effective_from"] == 5000 and meta["effective_to"] is None
    # Re-running the same change is a no-op (idempotent), still exactly two rows.
    await w.record_ticker_change(iid, old_ticker="FB", new_ticker="META", changed_at_ms=5000, old_effective_from=100)
    assert len(db.identifiers) == 2


@pytest.mark.asyncio
async def test_upsert_filing_idempotent_by_source_accession() -> None:
    db = FakeTimescale()
    w = SecurityMasterWriter(db)
    cid = await w.upsert_company(CompanyRecord(name="Co", cik="1"))
    iid = await w.upsert_instrument(InstrumentRecord(company_id=cid, instrument_type="common", t212_ticker="X_US_EQ"))
    f = FilingRecord(instrument_id=iid, accession_number="0000320193-20-000096", form_type="10-K",
                     source=SOURCE_SEC_EDGAR, filed_ts=1000, accepted_ts=1200, is_amendment=False)
    fid1 = await w.upsert_filing(f)
    fid2 = await w.upsert_filing(f)  # same (source, accession) → DO NOTHING, returns existing id
    assert fid1 == fid2
    assert len(db.filings) == 1
    assert db.filings[0]["accepted_ts"] == 1200


def test_country_for_ticker_via_market_router() -> None:
    assert country_for_ticker("AAPL_US_EQ") == COUNTRY_US
    assert country_for_ticker("VODl_EQ") == COUNTRY_GB
    assert country_for_ticker("SOMECRYPTO") is None  # unknown jurisdiction → not guessed
