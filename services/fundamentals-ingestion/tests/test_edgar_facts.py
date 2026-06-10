"""EDGAR fact downloader tests — pure parsers + fail-soft client + bulk-ZIP iteration, all fixtures.

The JSON fixtures mirror the SHAPE of the live SEC companyfacts / companyconcept APIs (the nested
`facts → taxonomy → tag → units → [factObj]` form, factObj = `{start?, end, val, accn, fy, fp, form,
frame?}`). No live network: the parsers are total functions over decoded JSON, and the client's I/O
path is driven with an httpx `MockTransport`; the bulk seed is exercised by building a zip in memory.
Live ingestion is the cron/backfill card's job (epic Task 9) — a one-shot AAPL+MSFT fetch may
demonstrate it, but the gate stays fixture-based + deterministic.

The bulk-ZIP URLs the client targets were verified (2026-06-08) against the maintained
`dgunning/edgartools` library — the test pins the resolved URLs so a typo'd path is a test failure."""
from __future__ import annotations

import io
import json
import zipfile

import pytest

from src.download.edgar import (
    COMPANY_CONCEPT_URL,
    COMPANY_FACTS_URL,
    COMPANY_FACTS_ZIP_URL,
    SUBMISSIONS_ZIP_URL,
    EdgarFactsClient,
    cik_from_zip_member,
    edgar_rate_limiter,
    iter_zip_members,
    parse_company_concept,
    parse_company_facts,
)
from src.security_master.rate_limiter import RateLimiter
from tests.fakes import httpx_transport

# ── fixtures (live-shape companyfacts) ────────────────────────────────────────
# AAPL: a duration flow (NetIncomeLoss, has start+end), an instant balance-sheet point
# (StockholdersEquity, end only), and a dei cover-page share count (own unit 'shares', no currency).
AAPL_FACTS_JSON = {
    "cik": 320193,
    "entityName": "Apple Inc.",
    "facts": {
        "us-gaap": {
            "NetIncomeLoss": {
                "label": "Net Income (Loss)",
                "description": "…",
                "units": {
                    "USD": [
                        {"start": "2019-09-29", "end": "2020-09-26", "val": 57411000000,
                         "accn": "0000320193-20-000096", "fy": 2020, "fp": "FY", "form": "10-K",
                         "frame": "CY2020"},
                        {"start": "2020-09-27", "end": "2021-09-25", "val": 94680000000,
                         "accn": "0000320193-21-000105", "fy": 2021, "fp": "FY", "form": "10-K"},
                    ]
                },
            },
            "StockholdersEquity": {
                "label": "Stockholders Equity",
                "units": {
                    "USD": [
                        {"end": "2020-09-26", "val": 65339000000, "accn": "0000320193-20-000096",
                         "fy": 2020, "fp": "FY", "form": "10-K"},
                    ]
                },
            },
        },
        "dei": {
            "EntityCommonStockSharesOutstanding": {
                "label": "Entity Common Stock, Shares Outstanding",
                "units": {
                    "shares": [
                        {"end": "2020-10-16", "val": 17001802000, "accn": "0000320193-20-000096",
                         "fy": 2020, "fp": "FY", "form": "10-K"},
                    ]
                },
            },
        },
        # A non-preserved taxonomy (srt:*) — must be ignored (preservation is scoped to us-gaap/dei).
        "srt": {
            "SomeRatio": {"units": {"pure": [{"end": "2020-09-26", "val": 1.5, "accn": "x",
                                              "fy": 2020, "fp": "FY", "form": "10-K"}]}},
        },
    },
}

MSFT_FACTS_JSON = {
    "cik": 789019,
    "entityName": "MICROSOFT CORP",
    "facts": {
        "us-gaap": {
            "Revenues": {
                "units": {
                    "USD": [
                        {"start": "2020-07-01", "end": "2021-06-30", "val": 168088000000,
                         "accn": "0001564590-21-000091", "fy": 2021, "fp": "FY", "form": "10-K"},
                    ]
                },
            },
        },
    },
}

# TSM: a foreign private issuer filing a 20-F under IFRS. Its income/balance-sheet facts are tagged in
# the `ifrs-full` taxonomy (ifrs-full:ProfitLoss / ifrs-full:Revenue), NOT us-gaap. The fixture also
# carries the dei cover-page share count (every EDGAR filer tags DEI, IFRS or not) so the test proves
# ifrs-full is preserved ALONGSIDE dei, and an unrelated `ifrs-sme:*` taxonomy to prove preservation
# stays scoped to the financial-reporting set (only `ifrs-full` of the IFRS taxonomies is in-contract).
TSM_FACTS_JSON = {
    "cik": 1046179,
    "entityName": "TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD",
    "facts": {
        "ifrs-full": {
            "ProfitLoss": {
                "label": "Profit (Loss)",
                "units": {
                    "USD": [
                        {"start": "2021-01-01", "end": "2021-12-31", "val": 21350000000,
                         "accn": "0001193125-22-000300", "fy": 2021, "fp": "FY", "form": "20-F",
                         "frame": "CY2021"},
                    ]
                },
            },
            "Revenue": {
                "label": "Revenue",
                "units": {
                    "USD": [
                        {"start": "2021-01-01", "end": "2021-12-31", "val": 56800000000,
                         "accn": "0001193125-22-000300", "fy": 2021, "fp": "FY", "form": "20-F"},
                    ]
                },
            },
            "Equity": {
                "label": "Equity",
                "units": {
                    "USD": [
                        {"end": "2021-12-31", "val": 67000000000, "accn": "0001193125-22-000300",
                         "fy": 2021, "fp": "FY", "form": "20-F"},
                    ]
                },
            },
        },
        "dei": {
            "EntityCommonStockSharesOutstanding": {
                "units": {
                    "shares": [
                        {"end": "2022-03-31", "val": 5186077000, "accn": "0001193125-22-000300",
                         "fy": 2021, "fp": "FY", "form": "20-F"},
                    ]
                },
            },
        },
        # A non-preserved IFRS taxonomy — must be ignored (only `ifrs-full` is in the contract).
        "ifrs-smes": {
            "ProfitLossSme": {"units": {"USD": [{"end": "2021-12-31", "val": 1.0, "accn": "x",
                                                 "fy": 2021, "fp": "FY", "form": "20-F"}]}},
        },
    },
}


# ── parse_company_facts ───────────────────────────────────────────────────────
def test_parse_company_facts_flattens_us_gaap_and_dei() -> None:
    facts = parse_company_facts(AAPL_FACTS_JSON)
    by_tag = {f.raw_tag: f for f in facts if f.period_end == _ms("2020-09-26")} or {}
    # us-gaap + dei preserved; srt dropped.
    tags = {f.raw_tag for f in facts}
    assert "us-gaap:NetIncomeLoss" in tags
    assert "us-gaap:StockholdersEquity" in tags
    assert "dei:EntityCommonStockSharesOutstanding" in tags
    assert not any(t.startswith("srt:") for t in tags)


def test_parse_company_facts_preserves_ifrs_full_for_foreign_filer() -> None:
    # A 20-F IFRS filer (TSM) tags income/balance-sheet facts under `ifrs-full`. The parser must keep
    # those verbatim — without this the alias in metric_registry.yaml has nothing to select and the
    # filer stages null for net_income/revenue. The parser is taxonomy-agnostic, so the IFRS facts carry
    # the SAME flattened identity (period_type, currency, accession, frame) as a us-gaap fact.
    facts = parse_company_facts(TSM_FACTS_JSON)
    tags = {f.raw_tag for f in facts}
    assert "ifrs-full:ProfitLoss" in tags
    assert "ifrs-full:Revenue" in tags
    assert "ifrs-full:Equity" in tags
    # dei is still preserved alongside ifrs-full; the non-contract `ifrs-smes` taxonomy is dropped.
    assert "dei:EntityCommonStockSharesOutstanding" in tags
    assert not any(t.startswith("ifrs-smes:") for t in tags)

    # The IFRS profit-or-loss fact retains full provenance — a duration flow in USD, with its accession.
    pl = next(f for f in facts if f.raw_tag == "ifrs-full:ProfitLoss")
    assert pl.period_type == "duration"
    assert pl.period_start == _ms("2021-01-01") and pl.period_end == _ms("2021-12-31")
    assert pl.value == 21350000000.0
    assert pl.unit == "USD" and pl.currency == "USD"
    assert pl.accession_number == "0001193125-22-000300"
    assert pl.fiscal_period == "FY" and pl.form == "20-F"
    # The IFRS equity fact is an instant (balance-sheet point: end only, no start).
    eq = next(f for f in facts if f.raw_tag == "ifrs-full:Equity")
    assert eq.period_type == "instant" and eq.period_start is None


def test_parse_company_facts_period_type_instant_vs_duration() -> None:
    facts = parse_company_facts(AAPL_FACTS_JSON)
    ni = next(f for f in facts if f.raw_tag == "us-gaap:NetIncomeLoss"
              and f.period_end == _ms("2020-09-26"))
    eq = next(f for f in facts if f.raw_tag == "us-gaap:StockholdersEquity")
    # NetIncomeLoss has a start → duration flow; StockholdersEquity has only end → instant point.
    assert ni.period_type == "duration"
    assert ni.period_start == _ms("2019-09-29")
    assert ni.value == 57411000000.0
    assert eq.period_type == "instant"
    assert eq.period_start is None


def test_parse_company_facts_currency_and_unit() -> None:
    facts = parse_company_facts(AAPL_FACTS_JSON)
    ni = next(f for f in facts if f.raw_tag == "us-gaap:NetIncomeLoss"
              and f.period_end == _ms("2020-09-26"))
    shares = next(f for f in facts if f.raw_tag == "dei:EntityCommonStockSharesOutstanding")
    # A USD monetary fact tags currency USD; a 'shares' count has no currency.
    assert ni.unit == "USD" and ni.currency == "USD"
    assert shares.unit == "shares" and shares.currency is None


def test_parse_company_facts_provenance_fields() -> None:
    facts = parse_company_facts(AAPL_FACTS_JSON)
    ni20 = next(f for f in facts if f.raw_tag == "us-gaap:NetIncomeLoss"
                and f.fiscal_year == 2020)
    assert ni20.accession_number == "0000320193-20-000096"
    assert ni20.fiscal_period == "FY"
    assert ni20.form == "10-K"
    assert ni20.frame == "CY2020"          # the consolidated frame, preserved
    # context_id / dim_signature default to '' (companyfacts is consolidated/undimensioned).
    assert ni20.context_id == "" and ni20.dim_signature == ""


def test_parse_company_facts_total_on_bad_input() -> None:
    assert parse_company_facts(None) == []
    assert parse_company_facts([]) == []
    assert parse_company_facts({"facts": "nope"}) == []
    # A tag whose body is malformed is skipped, not raised.
    assert parse_company_facts({"facts": {"us-gaap": {"X": "bad"}}}) == []


def test_parse_company_facts_drops_facts_without_end() -> None:
    # period_end is the observation + a NOT NULL PK column; a fact missing a parseable end is dropped.
    payload = {"facts": {"us-gaap": {"X": {"units": {"USD": [
        {"start": "2020-01-01", "val": 5, "accn": "a", "fy": 2020, "fp": "FY", "form": "10-K"},  # no end
        {"end": "2020-12-31", "val": 9, "accn": "a", "fy": 2020, "fp": "FY", "form": "10-K"},
    ]}}}}}
    facts = parse_company_facts(payload)
    assert len(facts) == 1 and facts[0].period_end == _ms("2020-12-31")


# ── parse_company_concept ─────────────────────────────────────────────────────
def test_parse_company_concept_single_tag_history() -> None:
    payload = {
        "cik": 320193, "taxonomy": "us-gaap", "tag": "NetIncomeLoss",
        "label": "Net Income (Loss)", "description": "…",
        "units": {"USD": [
            {"start": "2019-09-29", "end": "2020-09-26", "val": 57411000000,
             "accn": "0000320193-20-000096", "fy": 2020, "fp": "FY", "form": "10-K"},
        ]},
    }
    facts = parse_company_concept(payload)
    assert len(facts) == 1
    assert facts[0].raw_tag == "us-gaap:NetIncomeLoss"
    assert facts[0].period_type == "duration"


def test_parse_company_concept_total_on_bad_input() -> None:
    assert parse_company_concept(None) == []
    assert parse_company_concept({"units": {}}) == []          # missing taxonomy/tag
    assert parse_company_concept({"taxonomy": "us-gaap", "tag": "X"}) == []  # missing units → empty


# ── bulk-ZIP iteration ────────────────────────────────────────────────────────
def test_cik_from_zip_member() -> None:
    assert cik_from_zip_member("CIK0000320193.json") == "0000320193"
    assert cik_from_zip_member("submissions/CIK0000789019.json") == "0000789019"
    assert cik_from_zip_member("README.txt") is None
    assert cik_from_zip_member("CIKnope.json") is None


def test_iter_zip_members_yields_per_cik_json() -> None:
    blob = _zip({
        "CIK0000320193.json": AAPL_FACTS_JSON,
        "CIK0000789019.json": MSFT_FACTS_JSON,
        "metadata.json": {"not": "a cik member"},   # non-CIK member → skipped
    })
    got = dict(iter_zip_members(blob))
    assert set(got) == {"0000320193", "0000789019"}
    assert got["0000320193"]["entityName"] == "Apple Inc."


def test_iter_zip_members_scopes_to_coverage_set() -> None:
    blob = _zip({"CIK0000320193.json": AAPL_FACTS_JSON, "CIK0000789019.json": MSFT_FACTS_JSON})
    # only_ciks scopes the seed to the coverage set (universe+index) rather than the full corpus.
    got = dict(iter_zip_members(blob, only_ciks={"0000320193"}))
    assert set(got) == {"0000320193"}


def test_iter_zip_members_skips_corrupt_member() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("CIK0000320193.json", json.dumps(AAPL_FACTS_JSON))
        zf.writestr("CIK0000789019.json", "{ this is not json")   # corrupt → skipped, not raised
    got = dict(iter_zip_members(buf.getvalue()))
    assert set(got) == {"0000320193"}


# ── client I/O (fake transport) ───────────────────────────────────────────────
@pytest.mark.asyncio
async def test_client_fetches_company_facts_through_mock_transport() -> None:
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if "companyfacts/CIK0000320193.json" in str(request.url):
            assert request.headers.get("User-Agent")        # SEC requires a descriptive UA
            return httpx.Response(200, json=AAPL_FACTS_JSON)
        return httpx.Response(404)

    client = EdgarFactsClient(user_agent="trader-test contact@example.com",
                              transport=httpx_transport(handler), limiter=RateLimiter(1000, 1.0))
    facts = await client.fetch_company_facts(320193)         # int CIK padded for the URL
    assert {f.raw_tag for f in facts} >= {"us-gaap:NetIncomeLoss", "dei:EntityCommonStockSharesOutstanding"}


@pytest.mark.asyncio
async def test_client_fetches_company_concept_through_mock_transport() -> None:
    import httpx

    concept = {"cik": 320193, "taxonomy": "us-gaap", "tag": "Revenues",
               "units": {"USD": [{"start": "2019-09-29", "end": "2020-09-26", "val": 274515000000,
                                  "accn": "0000320193-20-000096", "fy": 2020, "fp": "FY", "form": "10-K"}]}}

    def handler(request: httpx.Request) -> httpx.Response:
        if "companyconcept/CIK0000320193/us-gaap/Revenues.json" in str(request.url):
            return httpx.Response(200, json=concept)
        return httpx.Response(404)

    client = EdgarFactsClient(user_agent="ua", transport=httpx_transport(handler),
                              limiter=RateLimiter(1000, 1.0))
    facts = await client.fetch_company_concept(320193, "us-gaap", "Revenues")
    assert len(facts) == 1 and facts[0].raw_tag == "us-gaap:Revenues"


@pytest.mark.asyncio
async def test_client_fetches_bulk_zip_bytes() -> None:
    import httpx

    blob = _zip({"CIK0000320193.json": AAPL_FACTS_JSON})

    def handler(request: httpx.Request) -> httpx.Response:
        # The verified bulk-ZIP URL — a path typo would 404 here and the assert below would fail.
        if str(request.url) == COMPANY_FACTS_ZIP_URL:
            return httpx.Response(200, content=blob,
                                  headers={"Content-Type": "application/zip"})
        return httpx.Response(404)

    client = EdgarFactsClient(user_agent="ua", transport=httpx_transport(handler),
                              limiter=RateLimiter(1000, 1.0))
    got = await client.fetch_company_facts_zip()
    assert got is not None
    assert dict(iter_zip_members(got))["0000320193"]["entityName"] == "Apple Inc."


@pytest.mark.asyncio
async def test_client_refuses_without_user_agent() -> None:
    # Empty UA ⇒ the client does NOT call SEC (would 403 / risk an IP block) and degrades to empty.
    called = {"n": 0}

    def handler(request):  # pragma: no cover - must never run
        called["n"] += 1
        import httpx
        return httpx.Response(200, json=AAPL_FACTS_JSON)

    client = EdgarFactsClient(user_agent="", transport=httpx_transport(handler),
                              limiter=RateLimiter(1000, 1.0))
    assert await client.fetch_company_facts(320193) == []
    assert await client.fetch_company_concept(320193, "us-gaap", "Revenues") == []
    assert await client.fetch_company_facts_zip() is None
    assert await client.fetch_submissions_zip() is None
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_client_fail_soft_on_non_200_and_error() -> None:
    import httpx

    client = EdgarFactsClient(user_agent="ua", transport=httpx_transport(lambda r: httpx.Response(500)),
                              limiter=RateLimiter(1000, 1.0))
    assert await client.fetch_company_facts(320193) == []     # non-200 → empty, no raise
    assert await client.fetch_company_facts_zip() is None

    def boom(request):
        raise httpx.ConnectError("network down")

    client2 = EdgarFactsClient(user_agent="ua", transport=httpx_transport(boom),
                               limiter=RateLimiter(1000, 1.0))
    assert await client2.fetch_company_facts(320193) == []    # transport error → empty, no raise


# ── rate-limiter factory + URL provenance ─────────────────────────────────────
def test_edgar_rate_limiter_defaults_to_ten_per_second() -> None:
    rl = edgar_rate_limiter()
    assert isinstance(rl, RateLimiter)
    # The shared 10 req/s window (SEC's courtesy limit). It never throws — back-pressure only.
    assert rl._max == 10 and rl._window_s == 1.0


def test_edgar_rate_limiter_honours_override_and_clamps() -> None:
    assert edgar_rate_limiter(4)._max == 4
    assert edgar_rate_limiter(0)._max == 1          # a limiter must admit at least one call


def test_verified_sec_urls_resolve() -> None:
    # Pin the verified endpoints so a path typo is a test failure (the plan flagged these as uncertain).
    assert COMPANY_FACTS_URL.format(cik="0000320193") == \
        "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"
    assert COMPANY_CONCEPT_URL.format(cik="0000320193", taxonomy="us-gaap", tag="NetIncomeLoss") == \
        "https://data.sec.gov/api/xbrl/companyconcept/CIK0000320193/us-gaap/NetIncomeLoss.json"
    assert COMPANY_FACTS_ZIP_URL == "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip"
    assert SUBMISSIONS_ZIP_URL == "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip"


# ── helpers ───────────────────────────────────────────────────────────────────
def _ms(date_str: str) -> int:
    from datetime import datetime, timezone
    return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)


def _zip(members: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, obj in members.items():
            zf.writestr(name, json.dumps(obj))
    return buf.getvalue()
