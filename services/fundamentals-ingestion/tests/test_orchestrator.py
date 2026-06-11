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


def _orchestrator(
    db: FakeTimescale, *, tickers=None, subs=None, facts=None, openfigi=None,
) -> IngestionOrchestrator:
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
        openfigi_client=openfigi,
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


# ── alias-bridge (ticker-rename / no_cik) fixtures + tests ─────────────────────────
# Meta's stable CIK (the rename-invariant key the FB→META alias bridges to). A two-filing companyfacts
# payload under THIS CIK proves the resolved CIK actually ingests fundamentals.
_META_CIK = "0001326801"
_META_RENAME_MS = _ms("2022-06-09")  # the FB→META rebrand date the alias is dated with
_M_ACCN_2022 = "0001326801-22-000076"
_M_ACCN_2023 = "0001326801-23-000064"


def _meta_facts_payload() -> dict:
    # A single required-metric (net_income) across two filings is enough to land canonical rows under the
    # resolved CIK; the alias path reuses the SAME per-filing pipeline as the AAPL fixture above.
    return {
        "cik": 1326801,
        "entityName": "Meta Platforms, Inc.",
        "facts": {
            "us-gaap": {
                "NetIncomeLoss": {"units": {"USD": [
                    {"start": "2021-01-01", "end": "2021-12-31", "val": 39370000000,
                     "accn": _M_ACCN_2022, "fy": 2021, "fp": "FY", "form": "10-K"},
                    {"start": "2022-01-01", "end": "2022-12-31", "val": 23200000000,
                     "accn": _M_ACCN_2023, "fy": 2022, "fp": "FY", "form": "10-K"},
                ]}},
            },
        },
    }


_META_SUBMISSIONS = {
    "cik": _META_CIK,
    "name": "Meta Platforms, Inc.",
    "tickers": ["META"],
    "exchanges": ["Nasdaq"],
    "sic": "7372",  # prepackaged software → general template
    "filings": {"recent": {
        "accessionNumber": [_M_ACCN_2023, _M_ACCN_2022],
        "form": ["10-K", "10-K"],
        "filingDate": ["2023-02-02", "2022-02-03"],
        "acceptanceDateTime": ["2023-02-01T18:05:00.000Z", "2022-02-02T18:05:00.000Z"],
        "primaryDocument": ["meta-20221231.htm", "meta-20211231.htm"],
    }},
}

# A SEC ticker map that does NOT carry META (the real-world state: the bulk map dropped the legacy FB and
# the test exercises the moment before/without META being in it) — so resolution MUST fall to the alias.
_TICKERS_WITHOUT_META = {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}}


def _ticker_identifiers(db: FakeTimescale) -> list[dict]:
    return [r for r in db.identifiers if r["identifier_type"] == "ticker"]


@pytest.mark.asyncio
async def test_alias_hit_resolves_cik_and_lands_rows_when_sec_map_misses() -> None:
    # META is absent from the SEC ticker map; the curated TICKER_ALIASES table bridges it to its CIK, so
    # the filer ingests instead of skipping no_cik (the headline outcome of the card).
    db = FakeTimescale()
    orch = _orchestrator(
        db, tickers=_TICKERS_WITHOUT_META,
        subs={_META_CIK: _META_SUBMISSIONS}, facts={_META_CIK: _meta_facts_payload()},
    )
    summary = await orch.run(["META"])

    assert summary.ingested == 1 and summary.skipped == 0
    assert summary.results[0].skipped_reason is None
    assert summary.results[0].cik == _META_CIK
    # The entity landed under the resolved CIK with the live T212 join key.
    assert len(db.companies) == 1 and db.companies[0]["cik"] == _META_CIK
    assert db.instruments[0]["t212_ticker"] == "META_US_EQ"
    # Canonical rows actually wrote under the resolved CIK (net_income across the two filings).
    canonical = [r for r in db.fundamentals if not r["is_superseded"]]
    assert canonical and all(r["metric"] == "net_income" for r in canonical)


@pytest.mark.asyncio
async def test_alias_rename_records_effective_dated_ticker_intervals() -> None:
    # The rename is recorded append-only: FB's ID_TICKER interval is closed at the rename instant and
    # META's is open from it — no fundamentals fact rewrite, just two effective-dated identifier rows.
    db = FakeTimescale()
    orch = _orchestrator(
        db, tickers=_TICKERS_WITHOUT_META,
        subs={_META_CIK: _META_SUBMISSIONS}, facts={_META_CIK: _meta_facts_payload()},
    )
    await orch.run(["META"])

    tickers = _ticker_identifiers(db)
    fb = next(r for r in tickers if r["identifier_value"] == "FB")
    meta = next(r for r in tickers if r["identifier_value"] == "META")
    assert len(tickers) == 2
    # Prior symbol closed at the rename instant; current symbol open from it (the half-open boundary the
    # as-of interval resolver keys off so a pre-rename replay still resolves FB).
    assert fb["effective_from"] == 0 and fb["effective_to"] == _META_RENAME_MS
    assert meta["effective_from"] == _META_RENAME_MS and meta["effective_to"] is None
    # Both intervals hang off the same instrument (one filer), and no fundamentals row was superseded by
    # the rename (it is purely a resolution concern).
    assert fb["instrument_id"] == meta["instrument_id"]
    assert all(not r["is_superseded"] for r in db.fundamentals)


@pytest.mark.asyncio
async def test_alias_rename_recording_is_idempotent() -> None:
    # A second run over the same fixtures re-asserts the exact two intervals (append_identifier's
    # exact-interval guard) — never a third row, never a mutation.
    db = FakeTimescale()
    orch = _orchestrator(
        db, tickers=_TICKERS_WITHOUT_META,
        subs={_META_CIK: _META_SUBMISSIONS}, facts={_META_CIK: _meta_facts_payload()},
    )
    await orch.run(["META"])
    await orch.run(["META"])
    assert len(_ticker_identifiers(db)) == 2
    assert len(db.companies) == 1 and len(db.instruments) == 1


@pytest.mark.asyncio
async def test_alias_resolves_even_when_already_in_sec_map() -> None:
    # If the SEC map DOES carry META, the native CIK wins and no alias rename is recorded (the alias is
    # only the fallback for a miss) — META gets the plain open-ended interval, not a FB→META pair.
    db = FakeTimescale()
    tickers_with_meta = {"0": {"cik_str": 1326801, "ticker": "META", "title": "Meta Platforms, Inc."}}
    orch = _orchestrator(
        db, tickers=tickers_with_meta,
        subs={_META_CIK: _META_SUBMISSIONS}, facts={_META_CIK: _meta_facts_payload()},
    )
    summary = await orch.run(["META"])
    assert summary.ingested == 1
    tickers = _ticker_identifiers(db)
    assert [r["identifier_value"] for r in tickers] == ["META"]
    assert tickers[0]["effective_from"] == 0 and tickers[0]["effective_to"] is None


@pytest.mark.asyncio
async def test_unmapped_symbol_still_skips_no_cik_when_no_alias() -> None:
    # A symbol the SEC map misses AND that has no alias entry still skips no_cik (never a fabricated CIK).
    db = FakeTimescale()
    orch = _orchestrator(db, tickers=_TICKERS_WITHOUT_META)
    summary = await orch.run(["ZZZZ"])
    assert summary.ingested == 0 and summary.skipped == 1
    assert summary.results[0].skipped_reason == "no_cik"
    assert db.companies == [] and db.fundamentals == []


class _FakeOpenFigi:
    """Records the symbols it was asked to map; returns a FIGI (identity hint) but never a CIK."""

    def __init__(self) -> None:
        self.queried: list[str] = []

    async def map_ticker(self, ticker, *, exch_code="US"):
        from src.security_master.openfigi import FigiMapping
        self.queried.append(ticker)
        return FigiMapping(query_ticker=ticker, figi="BBG000FAKE01", composite_figi="BBG000FAKE00",
                           name="Fake Co", exch_code="US", security_type="Common Stock")


@pytest.mark.asyncio
async def test_openfigi_fallback_identifies_but_does_not_fabricate_cik() -> None:
    # The OpenFIGI seam is the LAST resort for a symbol the SEC map + alias table both miss. It returns a
    # FIGI (an identity hint, logged for an operator), NOT a CIK — so the symbol still skips no_cik and
    # nothing is written. This keeps the seam real/exercised without inventing a CIK.
    db = FakeTimescale()
    figi = _FakeOpenFigi()
    orch = _orchestrator(db, tickers=_TICKERS_WITHOUT_META, openfigi=figi)
    summary = await orch.run(["NEWIPO"])
    assert summary.skipped == 1 and summary.results[0].skipped_reason == "no_cik"
    assert figi.queried == ["NEWIPO"]          # the fallback WAS consulted
    assert db.companies == [] and db.fundamentals == []  # but no fabricated entity/fact


@pytest.mark.asyncio
async def test_openfigi_not_consulted_when_alias_resolves() -> None:
    # An alias hit short-circuits before the OpenFIGI hop (it resolved a real CIK) — the fallback is for
    # genuine misses only, so it must not be queried for META.
    db = FakeTimescale()
    figi = _FakeOpenFigi()
    orch = _orchestrator(
        db, tickers=_TICKERS_WITHOUT_META, openfigi=figi,
        subs={_META_CIK: _META_SUBMISSIONS}, facts={_META_CIK: _meta_facts_payload()},
    )
    await orch.run(["META"])
    assert figi.queried == []


# ── memory hardening (plan §C4): one companyfacts payload resident at a time ────────
# The 768Mi backfill-Job pod must hold ONE filer's companyfacts in RAM at a time, never accumulate the
# whole curated-US walk. These tests pin that the orchestrator drops every reference to a name's parsed
# facts before the next name is fetched (so a heavy filer is reclaimable, not retained by the summary or
# a per-iteration handle). The proof is a weakref to a parsed `RawFact`: after the owning name finishes,
# the weakref must be dead under `gc.collect()` — i.e. the orchestrator holds no strong reference.

class _WeakrefRecordingFacts(EdgarFactsClient):
    """A facts client that parses fresh per call (so the orchestrator owns the only strong reference to
    the returned list) and records a WEAKREF — never a strong ref — to one `RawFact` per CIK. It also
    snapshots, at the moment each name is fetched, whether every PREVIOUS name's payload is already dead;
    that snapshot is the 'released between names' assertion (the prior name's `ingest_ticker` has
    returned and its `result` handle has been dropped by the time the next fetch runs)."""

    def __init__(self, facts_by_cik: dict) -> None:
        import weakref

        self._facts = facts_by_cik
        self._weakref = weakref
        self.parsed_refs: dict[str, "weakref.ref"] = {}
        # Per fetched CIK: were ALL earlier CIKs' parsed payloads already collected at this point?
        self.prior_dead_at_fetch: dict[str, bool] = {}

    async def fetch_company_facts(self, cik):
        import gc

        from src.security_master.edgar_submissions import pad_cik

        padded = pad_cik(cik)
        # Force a collection so a still-referenced prior payload would survive (and fail the snapshot),
        # while a properly-dropped one is reclaimed — the per-name boundary is what we are asserting.
        gc.collect()
        self.prior_dead_at_fetch[padded] = all(
            ref() is None for c, ref in self.parsed_refs.items() if c != padded
        )

        payload = self._facts.get(padded)
        if payload is None:
            return []
        facts = parse_company_facts(payload)
        # Record a weakref to a representative fact; do NOT keep a strong ref (that would defeat the test).
        if facts:
            self.parsed_refs[padded] = self._weakref.ref(facts[0])
        return facts


_MSFT_CIK = "0000789019"
_MS_ACCN_2021 = "0000789019-21-000001"


def _msft_facts_payload() -> dict:
    # A single-metric (net_income) one-filing MSFT payload — enough to land a canonical row under a
    # SECOND CIK so the two-name walk exercises the per-name boundary with distinct payloads.
    return {
        "cik": 789019,
        "entityName": "MICROSOFT CORP",
        "facts": {
            "us-gaap": {
                "NetIncomeLoss": {"units": {"USD": [
                    {"start": "2020-07-01", "end": "2021-06-30", "val": 61271000000,
                     "accn": _MS_ACCN_2021, "fy": 2021, "fp": "FY", "form": "10-K"},
                ]}},
            },
        },
    }


_MSFT_SUBMISSIONS = {
    "cik": _MSFT_CIK,
    "name": "MICROSOFT CORP",
    "tickers": ["MSFT"],
    "exchanges": ["Nasdaq"],
    "sic": "7372",  # prepackaged software → general template
    "filings": {"recent": {
        "accessionNumber": [_MS_ACCN_2021],
        "form": ["10-K"],
        "filingDate": ["2021-07-29"],
        "acceptanceDateTime": ["2021-07-28T18:05:00.000Z"],
        "primaryDocument": ["msft-20210630.htm"],
    }},
}


@pytest.mark.asyncio
async def test_companyfacts_payload_is_released_after_each_name() -> None:
    # The single-name proof: after a name's run completes, the orchestrator retains NO strong reference
    # to its parsed companyfacts — the weakref is dead under gc (so a heavy filer is reclaimable, not
    # held by the summary/result). This is the core memory-hardening invariant.
    import gc

    db = FakeTimescale()
    facts = _WeakrefRecordingFacts({"0000320193": _facts_payload()})
    orch = IngestionOrchestrator(
        submissions_client=_FakeSubmissions(_COMPANY_TICKERS, {"0000320193": _AAPL_SUBMISSIONS}),
        facts_client=facts,
        secmaster=SecurityMasterWriter(db),
        raw_writer=RawFactsWriter(db),
        fundamentals_writer=FundamentalsWriter(db),
        qa_engine=QaEngine(db),
    )
    summary = await orch.run(["AAPL"])

    # The name ingested for real (so the payload genuinely flowed through the pipeline, not a no-op skip).
    assert summary.ingested == 1 and summary.raw_written == 12
    # …and after the run nothing strong-references the parsed facts: the weakref is dead under gc.
    gc.collect()
    assert facts.parsed_refs["0000320193"]() is None, (
        "orchestrator still holds the AAPL companyfacts after its name completed — a deep backfill would "
        "then accumulate every filer's payload and OOM the 768Mi backfill-Job pod"
    )


@pytest.mark.asyncio
async def test_prior_payload_dropped_before_next_name_is_fetched() -> None:
    # The 'between names' proof: by the time the SECOND name (MSFT) is fetched, the FIRST name's (AAPL)
    # parsed payload is already collected — so the walk holds ONE payload resident at a time, never two
    # (the property that bounds the pod under a multi-name backfill).
    tickers = {
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "1": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
    }
    db = FakeTimescale()
    facts = _WeakrefRecordingFacts(
        {"0000320193": _facts_payload(), _MSFT_CIK: _msft_facts_payload()}
    )
    orch = IngestionOrchestrator(
        submissions_client=_FakeSubmissions(
            tickers, {"0000320193": _AAPL_SUBMISSIONS, _MSFT_CIK: _MSFT_SUBMISSIONS}
        ),
        facts_client=facts,
        secmaster=SecurityMasterWriter(db),
        raw_writer=RawFactsWriter(db),
        fundamentals_writer=FundamentalsWriter(db),
        qa_engine=QaEngine(db),
    )
    summary = await orch.run(["AAPL", "MSFT"])

    # Both names ingested (two distinct payloads actually flowed through).
    assert summary.ingested == 2
    # When MSFT was fetched, AAPL's payload was already dead — the prior name was released before the
    # next name's payload entered RAM (one payload resident at a time).
    assert facts.prior_dead_at_fetch[_MSFT_CIK] is True, (
        "AAPL companyfacts was still alive when MSFT was fetched — the backfill would hold two payloads "
        "at once, breaking the one-payload-at-a-time bound"
    )
    # And after the whole run, neither name's payload survives.
    import gc

    gc.collect()
    assert facts.parsed_refs["0000320193"]() is None
    assert facts.parsed_refs[_MSFT_CIK]() is None


# ── dual-class share recovery (epic post-pit-coverage-bugs, Task 8) ────────────────
# The orchestrator routes a dual-class name that staged NO consolidated shares onto the XBRL-instance
# fetch, writes the per-class share facts to the raw zone, and appends ONE derived consolidated
# shares_outstanding fact to the StageResult (or leaves it null + degrades to Yahoo, fail-closed).
from src.download.edgar import RawFact as _RawFact
from src.stage.class_shares import META_CIK as _META_CIK
from src.stage.class_shares import VISA_CIK as _VISA_CIK
from src.stage.resolver import InterpretedFact as _IFact
from src.stage.resolver import StageResult as _StageResult

_AXIS = "us-gaap:StatementClassOfStockAxis"


class _FakeClassShares:
    """Returns canned per-class RawFacts, recording the (cik, accession) it was asked for."""

    def __init__(self, facts: list) -> None:
        self._facts = facts
        self.calls: list = []

    async def fetch_class_shares(self, cik, accession, period_end_ms):
        self.calls.append((cik, accession, period_end_ms))
        return list(self._facts)


def _class_share(member: str, value: float, *, unit: str = "shares", tag: str = "EntityCommonStockSharesOutstanding"):
    return _RawFact(
        taxonomy="dei", tag=tag, period_type="instant", period_start=None, period_end=_ms("2024-03-31"),
        value=value, unit=unit, currency=None, accession_number="A1", fiscal_year=None,
        fiscal_period=None, form=None, context_id="c", dim_signature=f"{_AXIS}={member}",
    )


def _non_shares_staged() -> "_StageResult":
    f = _IFact(metric="net_income", cik=_META_CIK, value=1.0, unit="USD", currency="USD",
               period_start=None, period_end=_ms("2024-03-31"), period_type="duration",
               fiscal_year=2024, fiscal_period="Q1", dim_signature="", is_segment=False,
               raw_tag="us-gaap:NetIncomeLoss", accession_number="A1", knowledge_ts=None)
    return _StageResult(facts=(f,), conflicts=())


@pytest.mark.asyncio
async def test_dual_class_recovery_appends_consolidated_and_writes_raw() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    orch._class_shares = _FakeClassShares([
        _class_share("us-gaap:CommonClassAMember", 2_196_045_588),
        _class_share("us-gaap:CommonClassBMember", 342_377_716),
    ])
    accn_facts = [_class_share("us-gaap:CommonClassAMember", 2_196_045_588)]  # only used for period_end
    staged, raw = await orch._recover_dual_class_shares(
        _non_shares_staged(), accn_facts, cik=_META_CIK, accession="A1", filing_id=7, accepted_ts=_ms("2024-04-25"))
    shares = [f for f in staged.facts if f.metric == "shares_outstanding"]
    assert len(shares) == 1
    assert shares[0].value == 2_196_045_588 + 342_377_716
    assert shares[0].dim_signature == "" and shares[0].raw_tag.startswith("derived:")
    assert raw == 2                              # both per-class share facts written to the raw zone
    assert orch._class_shares.calls and orch._class_shares.calls[0][0] == _META_CIK


@pytest.mark.asyncio
async def test_dual_class_recovery_skips_non_dual_class_name() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    orch._class_shares = _FakeClassShares([_class_share("us-gaap:CommonClassAMember", 1)])
    base = _non_shares_staged()
    staged, raw = await orch._recover_dual_class_shares(
        base, [], cik="0000320193", accession="A1", filing_id=7, accepted_ts=1)  # AAPL, not dual-class
    assert staged is base and raw == 0
    assert orch._class_shares.calls == []        # never fetched


@pytest.mark.asyncio
async def test_dual_class_recovery_noop_when_shares_already_staged() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    orch._class_shares = _FakeClassShares([_class_share("us-gaap:CommonClassAMember", 1)])
    already = _StageResult(
        facts=(_IFact(metric="shares_outstanding", cik=_META_CIK, value=2.5e9, unit="shares", currency=None,
                      period_start=None, period_end=_ms("2024-03-31"), period_type="instant",
                      fiscal_year=None, fiscal_period=None, dim_signature="", is_segment=False,
                      raw_tag="us-gaap:CommonStockSharesOutstanding", accession_number="A1", knowledge_ts=None),),
        conflicts=())
    staged, raw = await orch._recover_dual_class_shares(
        already, [], cik=_META_CIK, accession="A1", filing_id=7, accepted_ts=1)
    assert staged is already and raw == 0 and orch._class_shares.calls == []


@pytest.mark.asyncio
async def test_dual_class_visa_failclosed_writes_raw_but_no_consolidated() -> None:
    db = FakeTimescale()
    orch = _orchestrator(db)
    # Visa per-class shares but NO conversion ratios → as-converted unresolved → fail-closed (no fact).
    orch._class_shares = _FakeClassShares([
        _class_share("us-gaap:CommonClassAMember", 1_659_709_932),
        _class_share("v:CommonClassBMember", 245_000_000),
    ])
    accn_facts = [_class_share("us-gaap:CommonClassAMember", 1_659_709_932)]
    staged, raw = await orch._recover_dual_class_shares(
        _non_shares_staged(), accn_facts, cik=_VISA_CIK, accession="A1", filing_id=7, accepted_ts=1)
    assert [f for f in staged.facts if f.metric == "shares_outstanding"] == []  # fail-closed → Yahoo
    assert raw == 2                              # per-class shares still preserved in the raw zone
