"""EDGAR submissions client tests — pure parsers + fail-soft client behaviour, all against fixtures.

The JSON fixtures mirror the SHAPES of the live SEC files (verified against
`https://www.sec.gov/files/company_tickers.json` and
`https://data.sec.gov/submissions/CIK##########.json`): `company_tickers.json` is an object keyed by
an index string → `{cik_str, ticker, title}`; submissions carries top-level `cik`/`name`/`tickers`/
`exchanges` and a `filings.recent` block of PARALLEL arrays
(`accessionNumber`/`form`/`filingDate`/`acceptanceDateTime`/`primaryDocument`).

No live network: the parsers are total functions over decoded JSON, and the client's I/O path is
driven with an httpx `MockTransport`. Live ingestion is the cron/backfill card's job (epic Task 9)."""
from __future__ import annotations

import json

import pytest

from src.security_master.edgar_submissions import (
    EdgarSubmissionsClient,
    parse_company_tickers,
    parse_submissions,
)
from src.security_master.rate_limiter import RateLimiter
from tests.fakes import httpx_transport

# ── fixtures (live-shape) ────────────────────────────────────────────────────
COMPANY_TICKERS_JSON = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"},
    # Meta's CIK now carries META (post-rename) — this is how the bulk map first reveals the rename.
    "2": {"cik_str": 1326801, "ticker": "META", "title": "Meta Platforms, Inc."},
    "3": {"bad": "row"},                      # malformed → skipped
}

META_SUBMISSIONS_JSON = {
    "cik": "0001326801",
    "name": "Meta Platforms, Inc.",
    "tickers": ["META"],
    "exchanges": ["Nasdaq"],
    "filings": {
        "recent": {
            "accessionNumber": ["0001326801-22-000018", "0001326801-19-000009"],
            "form": ["10-K", "10-K"],
            "filingDate": ["2022-02-03", "2019-01-31"],
            # After-hours acceptance: 17:32 ET → the fact is only knowable next session (the writer's
            # knowledge_ts derivation, Task 7, consumes this exact field).
            "acceptanceDateTime": ["2022-02-02T17:32:10.000Z", "2019-01-30T16:05:00.000Z"],
            "primaryDocument": ["fb-20211231.htm", "fb-20181231.htm"],
        }
    },
}


# ── parse_company_tickers ────────────────────────────────────────────────────
def test_parse_company_tickers_normalises_and_skips_bad_rows() -> None:
    entries = parse_company_tickers(COMPANY_TICKERS_JSON)
    by_ticker = {e.ticker: e for e in entries}
    assert set(by_ticker) == {"AAPL", "MSFT", "META"}          # the malformed row is dropped
    assert by_ticker["AAPL"].cik == "0000320193"               # zero-padded to 10
    assert by_ticker["META"].cik == "0001326801"
    assert by_ticker["MSFT"].title == "MICROSOFT CORP"


def test_parse_company_tickers_empty_on_non_dict() -> None:
    assert parse_company_tickers([]) == []
    assert parse_company_tickers(None) == []


# ── parse_submissions ────────────────────────────────────────────────────────
def test_parse_submissions_shape_and_timestamps() -> None:
    parsed = parse_submissions(META_SUBMISSIONS_JSON)
    assert parsed is not None
    assert parsed.cik == "0001326801"
    assert parsed.name == "Meta Platforms, Inc."
    assert parsed.tickers == ("META",)
    assert parsed.exchanges == ("Nasdaq",)
    assert len(parsed.filings) == 2

    f0 = parsed.filings[0]
    assert f0.accession_number == "0001326801-22-000018"
    assert f0.form == "10-K"
    assert f0.primary_document == "fb-20211231.htm"
    assert f0.is_amendment is False
    # acceptanceDateTime 2022-02-02T17:32:10Z → UTC ms.
    assert f0.accepted_ts == 1643823130000
    # filingDate 2022-02-03 → UTC midnight ms.
    assert f0.filed_ts == 1643846400000
    # The accepted timestamp precedes the filing-date midnight (after-hours accept, next-day stamp) —
    # exactly why knowledge_ts is derived from accepted_ts via the calendar, not filingDate.
    assert f0.accepted_ts < f0.filed_ts


def test_parse_submissions_flags_amendments() -> None:
    payload = {
        "cik": "1",
        "name": "Co",
        "tickers": ["X"],
        "exchanges": ["NYSE"],
        "filings": {"recent": {
            "accessionNumber": ["a1", "a2"],
            "form": ["10-K/A", "10-Q"],
            "filingDate": ["2021-03-01", "2021-05-01"],
            "acceptanceDateTime": ["2021-03-01T10:00:00.000Z", "2021-05-01T10:00:00.000Z"],
            "primaryDocument": ["x.htm", "y.htm"],
        }},
    }
    parsed = parse_submissions(payload)
    assert parsed is not None
    assert parsed.filings[0].is_amendment is True     # 10-K/A
    assert parsed.filings[1].is_amendment is False


def test_parse_submissions_tolerates_missing_filings_block() -> None:
    parsed = parse_submissions({"cik": "1", "name": "Co", "tickers": [], "exchanges": []})
    assert parsed is not None
    assert parsed.filings == ()


def test_parse_submissions_none_on_missing_cik() -> None:
    assert parse_submissions({"name": "Co"}) is None
    assert parse_submissions("not-json") is None


def test_parse_submissions_ragged_arrays_truncate() -> None:
    # form shorter than accessionNumber: zip to the shorter required length, don't index-error.
    payload = {
        "cik": "1", "name": "Co", "tickers": [], "exchanges": [],
        "filings": {"recent": {
            "accessionNumber": ["a1", "a2", "a3"],
            "form": ["10-K"],            # only one form
            "filingDate": ["2021-01-01"],
            "acceptanceDateTime": ["2021-01-01T10:00:00.000Z"],
            "primaryDocument": [],
        }},
    }
    parsed = parse_submissions(payload)
    assert parsed is not None and len(parsed.filings) == 1


# ── client I/O (fake transport) ──────────────────────────────────────────────
@pytest.mark.asyncio
async def test_client_fetches_through_mock_transport() -> None:
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if "company_tickers.json" in str(request.url):
            assert request.headers.get("User-Agent")        # SEC requires a descriptive UA
            return httpx.Response(200, json=COMPANY_TICKERS_JSON)
        if "CIK0001326801.json" in str(request.url):
            return httpx.Response(200, json=META_SUBMISSIONS_JSON)
        return httpx.Response(404)

    # A generous limiter so the test isn't slowed by real sleeps.
    client = EdgarSubmissionsClient(user_agent="trader-test contact@example.com",
                                    transport=httpx_transport(handler),
                                    limiter=RateLimiter(1000, 1.0))
    tickers = await client.fetch_company_tickers()
    assert {e.ticker for e in tickers} == {"AAPL", "MSFT", "META"}

    subs = await client.fetch_submissions(1326801)           # int CIK is padded for the URL
    assert subs is not None and subs.cik == "0001326801" and subs.tickers == ("META",)


@pytest.mark.asyncio
async def test_client_refuses_without_user_agent() -> None:
    # Empty UA ⇒ the client does NOT call SEC (would 403 / risk an IP block) and degrades to empty.
    called = {"n": 0}

    def handler(request):  # pragma: no cover - must never run
        called["n"] += 1
        import httpx
        return httpx.Response(200, json=COMPANY_TICKERS_JSON)

    client = EdgarSubmissionsClient(user_agent="", transport=httpx_transport(handler),
                                    limiter=RateLimiter(1000, 1.0))
    assert await client.fetch_company_tickers() == []
    assert await client.fetch_submissions(320193) is None
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_client_fail_soft_on_non_200_and_error() -> None:
    import httpx

    def handler_500(request):
        return httpx.Response(500, text="boom")

    client = EdgarSubmissionsClient(user_agent="ua", transport=httpx_transport(handler_500),
                                    limiter=RateLimiter(1000, 1.0))
    assert await client.fetch_company_tickers() == []         # non-200 → empty, no raise
    assert await client.fetch_submissions(1) is None

    def handler_raise(request):
        raise httpx.ConnectError("network down")

    client2 = EdgarSubmissionsClient(user_agent="ua", transport=httpx_transport(handler_raise),
                                     limiter=RateLimiter(1000, 1.0))
    assert await client2.fetch_company_tickers() == []        # transport error → empty, no raise


def test_company_tickers_fixture_is_valid_json() -> None:
    # Guard: the fixture must round-trip as JSON (it stands in for the real downloaded file).
    assert json.loads(json.dumps(COMPANY_TICKERS_JSON))["0"]["ticker"] == "AAPL"
