"""Ingestion orchestrator tests — the per-ticker pipeline wiring (epic Task 9).

This is the deterministic proof that the cron's orchestrator WIRES the stage modules together correctly
— resolve CIK → fetch submissions+facts → upsert security master → raw zone → SIC→template → per-filing
stage → bi-temporal write → QA in-line — landing real `fundamentals` rows, idempotently. It runs against
the in-memory `FakeTimescale` (the same fake the writer/QA tests use, whose run_execute permits only the
append-only + supersede statements) and FAKE EDGAR clients returning fixture payloads. No network, no DB:
the live EDGAR backfill (a real EDGAR_USER_AGENT + external egress) is the operator step, not the gate.

The fixtures use Task 5's real `parse_company_facts` over live-shape companyfacts JSON, so the staging
the orchestrator drives is the genuine resolver — only the I/O (the HTTP fetch) is faked.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.download.edgar import EdgarFactsClient, parse_company_facts
from src.normalize.writer import SOURCE_PIT_EDGAR, FundamentalsWriter
from src.orchestrator import IngestionOrchestrator, build_ticker_cik_map
from src.qa.engine import QaEngine
from src.raw_store.writer import RawFactsWriter
from src.security_master.edgar_submissions import (
    EdgarSubmissionsClient,
    parse_company_tickers,
    parse_submissions,
)
from src.security_master.writers import SecurityMasterWriter
from tests.fakes import FakeTimescale


def _ms(date_str: str) -> int:
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


# ── live-shape fixtures ───────────────────────────────────────────────────────────
# A two-filing AAPL companyfacts payload: FY2020 (accession -20-) and FY2021 (accession -21-). Each
# filing carries the five REQUIRED_METRICS (revenue, net_income, total_equity, total_assets,
# shares_outstanding) + total_liabilities, and the FY2020 balance sheet BALANCES (assets = L + E) so the
# General identity check passes cleanly. Two distinct accessions exercise the per-filing grouping.
_ACCN_2020 = "0000320193-20-000096"
_ACCN_2021 = "0000320193-21-000105"


def _facts_payload() -> dict:
    return {
        "cik": 320193,
        "entityName": "Apple Inc.",
        "facts": {
            "us-gaap": {
                "NetIncomeLoss": {"units": {"USD": [
                    {"start": "2019-09-29", "end": "2020-09-26", "val": 57411000000,
                     "accn": _ACCN_2020, "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"start": "2020-09-27", "end": "2021-09-25", "val": 94680000000,
                     "accn": _ACCN_2021, "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
                "Revenues": {"units": {"USD": [
                    {"start": "2019-09-29", "end": "2020-09-26", "val": 274515000000,
                     "accn": _ACCN_2020, "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"start": "2020-09-27", "end": "2021-09-25", "val": 365817000000,
                     "accn": _ACCN_2021, "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
                "StockholdersEquity": {"units": {"USD": [
                    {"end": "2020-09-26", "val": 65339000000, "accn": _ACCN_2020,
                     "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"end": "2021-09-25", "val": 63090000000, "accn": _ACCN_2021,
                     "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
                "Assets": {"units": {"USD": [
                    {"end": "2020-09-26", "val": 323888000000, "accn": _ACCN_2020,
                     "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"end": "2021-09-25", "val": 351002000000, "accn": _ACCN_2021,
                     "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
                "Liabilities": {"units": {"USD": [
                    # FY2020 balances: 258549 + 65339 = 323888 = Assets (identity check passes).
                    {"end": "2020-09-26", "val": 258549000000, "accn": _ACCN_2020,
                     "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"end": "2021-09-25", "val": 287912000000, "accn": _ACCN_2021,
                     "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
            },
            "dei": {
                "EntityCommonStockSharesOutstanding": {"units": {"shares": [
                    {"end": "2020-09-26", "val": 17001802000, "accn": _ACCN_2020,
                     "fy": 2020, "fp": "FY", "form": "10-K"},
                    {"end": "2021-09-25", "val": 16406397000, "accn": _ACCN_2021,
                     "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
            },
        },
    }


_COMPANY_TICKERS = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
}

_AAPL_SUBMISSIONS = {
    "cik": "0000320193",
    "name": "Apple Inc.",
    "tickers": ["AAPL"],
    "exchanges": ["Nasdaq"],
    "sic": "3571",  # Electronic Computers → general template
    "filings": {"recent": {
        "accessionNumber": [_ACCN_2021, _ACCN_2020],
        "form": ["10-K", "10-K"],
        "filingDate": ["2021-10-29", "2020-10-30"],
        # After-hours accepts (the writer derives knowledge_ts = next session open).
        "acceptanceDateTime": ["2021-10-28T18:01:00.000Z", "2020-10-29T18:00:00.000Z"],
        "primaryDocument": ["aapl-20210925.htm", "aapl-20200926.htm"],
    }},
}


# ── fake EDGAR clients (fixture I/O; the parsers are the real ones) ─────────────────
class _FakeSubmissions(EdgarSubmissionsClient):
    def __init__(self, tickers_payload: dict, submissions_by_cik: dict) -> None:
        # Skip the real __init__ (no UA / limiter needed — the fetches are overridden).
        self._tickers_payload = tickers_payload
        self._subs = submissions_by_cik

    async def fetch_company_tickers(self):
        return parse_company_tickers(self._tickers_payload)

    async def fetch_submissions(self, cik):
        from src.security_master.edgar_submissions import pad_cik
        payload = self._subs.get(pad_cik(cik))
        return parse_submissions(payload) if payload is not None else None


class _FakeFacts(EdgarFactsClient):
    def __init__(self, facts_by_cik: dict) -> None:
        self._facts = facts_by_cik

    async def fetch_company_facts(self, cik):
        from src.security_master.edgar_submissions import pad_cik
        payload = self._facts.get(pad_cik(cik))
        return parse_company_facts(payload) if payload is not None else []


def _orchestrator(db: FakeTimescale, *, tickers=None, subs=None, facts=None) -> IngestionOrchestrator:
    return IngestionOrchestrator(
        submissions_client=_FakeSubmissions(
            tickers if tickers is not None else _COMPANY_TICKERS,
            subs if subs is not None else {"0000320193": _AAPL_SUBMISSIONS},
        ),
        facts_client=_FakeFacts(facts if facts is not None else {"0000320193": _facts_payload()}),
        secmaster=SecurityMasterWriter(db),
        raw_writer=RawFactsWriter(db),
        fundamentals_writer=FundamentalsWriter(db),
        qa_engine=QaEngine(db),
    )


# ── tests ───────────────────────────────────────────────────────────────────────
def test_build_ticker_cik_map_dedups_first_wins() -> None:
    entries = parse_company_tickers({
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple"},
        "1": {"cik_str": 999999, "ticker": "AAPL", "title": "Impostor"},  # dup symbol → first kept
    })
    m = build_ticker_cik_map(entries)
    assert m["AAPL"] == "0000320193"


@pytest.mark.asyncio
async def test_full_pipeline_lands_canonical_and_raw_rows() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    summary = await orch.run(["AAPL"])

    # One ticker ingested; the security master got the entity + instrument + ticker identifier + filings.
    assert summary.requested == 1 and summary.ingested == 1 and summary.skipped == 0
    assert len(db.companies) == 1 and db.companies[0]["cik"] == "0000320193"
    assert len(db.instruments) == 1 and db.instruments[0]["t212_ticker"] == "AAPL_US_EQ"
    assert db.instruments[0]["currency"] == "USD"
    assert len(db.filings) == 2  # both 10-Ks upserted with accepted_ts

    # Raw zone: every us-gaap/dei fact preserved (6 tags × 2 filings = 12 facts).
    assert summary.raw_written == 12 and len(db.raw_facts) == 12

    # Canonical: 6 metrics × 2 filings = 12 first-print rows, all current.
    canonical = [r for r in db.fundamentals if not r["is_superseded"]]
    assert len(canonical) == 12 and summary.canonical_inserted == 12
    assert summary.canonical_revisions == 0
    metrics = {r["metric"] for r in canonical}
    assert metrics == {"net_income", "total_revenue", "total_equity", "total_assets",
                       "total_liabilities", "shares_outstanding"}
    assert all(r["source"] == SOURCE_PIT_EDGAR for r in canonical)

    # knowledge_ts is DERIVED (next session open after the after-hours accept), strictly later than the
    # accept — never the raw accepted_ts.
    fy2020_ni = next(r for r in canonical
                     if r["metric"] == "net_income" and r["observation_ts"] == _ms("2020-09-26"))
    assert fy2020_ni["knowledge_ts"] > _ms("2020-10-29")  # past the accept day

    # A clean, balancing filing with all required metrics → no quarantine.
    assert summary.quarantined == 0


@pytest.mark.asyncio
async def test_pipeline_is_idempotent_on_rerun() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    await orch.run(["AAPL"])
    canonical_after_first = len([r for r in db.fundamentals if not r["is_superseded"]])
    raw_after_first = len(db.raw_facts)

    # Second run over the SAME fixtures: hash gate → zero new canonical rows, zero new raw rows.
    summary2 = await orch.run(["AAPL"])
    assert summary2.canonical_inserted == 0
    assert summary2.canonical_skipped == 12       # every fact's hash matched the current row
    assert summary2.raw_written == 0
    assert len([r for r in db.fundamentals if not r["is_superseded"]]) == canonical_after_first
    assert len(db.raw_facts) == raw_after_first
    # The security master did not duplicate the entity/instrument either.
    assert len(db.companies) == 1 and len(db.instruments) == 1


@pytest.mark.asyncio
async def test_per_filing_grouping_uses_each_accessions_lineage() -> None:
    # The two filings have DIFFERENT accepted_ts → DIFFERENT derived knowledge_ts. Each filing's facts
    # must carry ITS filing's knowledge_ts (not one shared value) — the per-accession lineage contract.
    db = FakeTimescale()
    orch = _orchestrator(db)
    await orch.run(["AAPL"])
    canonical = [r for r in db.fundamentals if not r["is_superseded"]]
    k_2020 = {r["knowledge_ts"] for r in canonical if r["observation_ts"] == _ms("2020-09-26")}
    k_2021 = {r["knowledge_ts"] for r in canonical if r["observation_ts"] == _ms("2021-09-25")}
    assert len(k_2020) == 1 and len(k_2021) == 1
    assert k_2020 != k_2021                       # distinct filings → distinct availability instants


@pytest.mark.asyncio
async def test_unknown_ticker_skips_no_cik() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    summary = await orch.run(["NOPE"])
    assert summary.ingested == 0 and summary.skipped == 1
    assert summary.results[0].skipped_reason == "no_cik"
    assert db.fundamentals == [] and db.companies == []


@pytest.mark.asyncio
async def test_no_facts_still_upserts_entity_then_skips() -> None:
    # A filer in the ticker map + submissions but with NO companyfacts: the entity is still recorded
    # (resolves for a later run / the read API), but no fact write happens.
    db = FakeTimescale()
    orch = _orchestrator(db, facts={})  # empty facts map → fetch_company_facts returns []
    summary = await orch.run(["AAPL"])
    assert summary.results[0].skipped_reason == "no_facts"
    assert len(db.companies) == 1 and len(db.instruments) == 1
    assert db.fundamentals == [] and db.raw_facts == []


@pytest.mark.asyncio
async def test_bank_sic_selects_bank_template() -> None:
    # A bank SIC must route staging through the 'bank' template — proven by the TickerResult.sector. A
    # bank's revenue tag differs (net interest income), so the general Revenues fixture won't resolve
    # total_revenue under the bank template; the point here is the template SELECTION wiring.
    bank_subs = dict(_AAPL_SUBMISSIONS, sic="6022")  # state commercial bank
    db = FakeTimescale()
    orch = _orchestrator(db, subs={"0000320193": bank_subs})
    summary = await orch.run(["AAPL"])
    assert summary.results[0].sector == "bank"


@pytest.mark.asyncio
async def test_full_pipeline_populates_company_sector() -> None:
    # The SIC→QA template must land on companies.sector (not just the TickerResult) so the quarantine
    # by_sector JOIN can bucket the filer. AAPL's SIC 3571 → 'general'.
    db = FakeTimescale()
    orch = _orchestrator(db)
    await orch.run(["AAPL"])
    assert len(db.companies) == 1
    assert db.companies[0]["sector"] == "general"


@pytest.mark.asyncio
async def test_bank_sic_populates_bank_sector_on_company_row() -> None:
    # The selected non-general template reaches the row too: a bank SIC writes 'bank' to companies.sector.
    bank_subs = dict(_AAPL_SUBMISSIONS, sic="6022")  # state commercial bank
    db = FakeTimescale()
    orch = _orchestrator(db, subs={"0000320193": bank_subs})
    await orch.run(["AAPL"])
    assert db.companies[0]["sector"] == "bank"


@pytest.mark.asyncio
async def test_no_facts_path_populates_company_sector() -> None:
    # The no-facts skip still records the entity AND its sector (sector is computed before the upsert and
    # passed on both call sites), so a filer we can't yet ingest facts for still buckets in by_sector.
    db = FakeTimescale()
    orch = _orchestrator(db, facts={})  # empty facts map → fetch_company_facts returns []
    summary = await orch.run(["AAPL"])
    assert summary.results[0].skipped_reason == "no_facts"
    assert db.companies[0]["sector"] == "general"       # SIC 3571 → general, still populated


@pytest.mark.asyncio
async def test_rerun_preserves_company_sector() -> None:
    # Idempotency extends to sector: a second run over the same fixtures re-asserts the same template via
    # the IS DISTINCT FROM-gated UPDATE (a no-op), never duplicating the issuer or nulling the sector.
    db = FakeTimescale()
    orch = _orchestrator(db)
    await orch.run(["AAPL"])
    await orch.run(["AAPL"])
    assert len(db.companies) == 1
    assert db.companies[0]["sector"] == "general"


@pytest.mark.asyncio
async def test_filing_without_accepted_ts_is_skipped_for_facts() -> None:
    # A filing whose accepted_ts SEC omitted has no honest knowledge_ts to stamp → its facts are not
    # written canonically (the bi-temporal contract). Here the FY2020 filing loses its accept time, so
    # only the FY2021 filing's facts land.
    subs_no_accept = {
        "cik": "0000320193", "name": "Apple Inc.", "tickers": ["AAPL"], "exchanges": ["Nasdaq"],
        "sic": "3571",
        "filings": {"recent": {
            "accessionNumber": [_ACCN_2021, _ACCN_2020],
            "form": ["10-K", "10-K"],
            "filingDate": ["2021-10-29", "2020-10-30"],
            "acceptanceDateTime": ["2021-10-28T18:01:00.000Z", ""],  # FY2020 accept missing
            "primaryDocument": ["a.htm", "b.htm"],
        }},
    }
    db = FakeTimescale()
    orch = _orchestrator(db, subs={"0000320193": subs_no_accept})
    await orch.run(["AAPL"])
    obs = {r["observation_ts"] for r in db.fundamentals if not r["is_superseded"]}
    assert _ms("2021-09-25") in obs           # FY2021 wrote
    assert _ms("2020-09-26") not in obs       # FY2020 skipped (no accepted_ts → no lineage)
