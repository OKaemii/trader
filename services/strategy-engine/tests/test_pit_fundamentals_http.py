"""Tests for PitFundamentalsAsOf — the concrete HTTP client over fundamentals-api (epic Task 14).

Mocks the HTTP layer via respx (no network), the same way test_market_data_client.py does. Pins:
  - the seam URL shape: GET {base}/internal/api/fundamentals-pit?tickers=&asOf= (camelCase asOf, the
    bars/pg-bar-reader convention — NOT as_of);
  - the internal-JWT auth header (minted as `strategy-engine`, the caller market-data already
    authorizes on the bars/fundamentals routes);
  - the payload→line-item projection (LINE_ITEMS only, finite values, provenance dropped) and the
    "covered but no fact ≤ asOf → empty line items → absent from the map" contract (so the router
    falls back to Yahoo for that name in live);
  - LIVE SAFETY: a transport error, a 503 (cold warehouse), or malformed JSON degrade to {} — NEVER
    raised into the cycle (the single most important property for the live trading host);
  - source_for routes pit-edgar (US) / pit-companies-house (UK).

The deps-light routing/build tests live in test_fundamentals_as_of.py; this file is the HTTP twin.
"""
from __future__ import annotations

import base64
import json

import httpx
import pytest
import respx

from src.infrastructure.fundamentals_as_of import (
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    PitFundamentalsAsOf,
)

BASE_URL = "http://fundamentals-api:8011"
SECRET = "test-secret"


def _bearer(request: httpx.Request) -> dict:
    """Decode the unverified JWT payload off the Authorization header — enough to assert the caller
    claim + audience without re-implementing verification (mirrors test_market_data_client._bearer)."""
    auth = request.headers.get("Authorization", "")
    assert auth.startswith("Bearer "), f"missing/!bearer Authorization: {auth!r}"
    payload_b64 = auth.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)  # pad for urlsafe_b64decode
    return json.loads(base64.urlsafe_b64decode(payload_b64))


def _provider() -> PitFundamentalsAsOf:
    return PitFundamentalsAsOf(base_url=BASE_URL, secret=SECRET)


# A fundamentals-api seam payload: line items + the provenance triple per name (the resolver shape).
_PIT_PAYLOAD = {
    "fundamentals": {
        "AAPL_US_EQ": {
            "net_income": 9.9e10,
            "total_equity": 6.2e10,
            "current_assets": 1.4e11,
            "current_liabilities": 1.3e11,
            "shares_outstanding": 1.6e10,
            "market_cap_gbp": 2.4e12,
            "source": "pit-edgar",
            "observation_ts": 1_600_000_000_000,
            "knowledge_ts": 1_600_100_000_000,
        },
        # A covered-but-unseeded name: empty line items + null provenance → must be ABSENT from the map
        # (so RoutingFundamentalsAsOf falls back to Yahoo for it in live).
        "MSFT_US_EQ": {"source": None, "observation_ts": None, "knowledge_ts": None},
    },
    "asOf": 1_600_100_000_000,
    "count": 2,
}


@pytest.mark.asyncio
async def test_fetch_many_hits_seam_url_with_jwt_and_projects():
    """The seam GET uses the camelCase asOf param + a strategy-engine bearer, and the response is
    projected onto LINE_ITEMS (provenance dropped); an empty-line-item name is absent from the map."""
    provider = _provider()
    as_of = 1_600_100_000_000
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["claims"] = _bearer(request)
        return httpx.Response(200, json=_PIT_PAYLOAD)

    with respx.mock() as mock:
        mock.get(
            f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ,MSFT_US_EQ&asOf={as_of}"
        ).mock(side_effect=handler)
        out = await provider.fetch_many(["AAPL_US_EQ", "MSFT_US_EQ"], as_of)

    # URL: the seam path + camelCase asOf (NOT as_of).
    assert "/internal/api/fundamentals-pit" in captured["url"]
    assert f"asOf={as_of}" in captured["url"]
    # Auth: minted as strategy-engine, aud internal.
    assert captured["claims"]["sub"] == "strategy-engine"
    assert captured["claims"]["aud"] == "internal"
    # Projection: AAPL kept (finite line items, provenance dropped); MSFT (empty) absent.
    assert set(out.keys()) == {"AAPL_US_EQ"}
    aapl = out["AAPL_US_EQ"]
    assert aapl["net_income"] == pytest.approx(9.9e10)
    assert aapl["market_cap_gbp"] == pytest.approx(2.4e12)
    assert "source" not in aapl and "observation_ts" not in aapl and "knowledge_ts" not in aapl


@pytest.mark.asyncio
async def test_fetch_single_name():
    """fetch() returns one name's line items over fetch_many."""
    provider = _provider()
    as_of = 1_600_100_000_000
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            return_value=httpx.Response(
                200,
                json={"fundamentals": {"AAPL_US_EQ": {"net_income": 1.0, "source": "pit-edgar"}}},
            )
        )
        out = await provider.fetch("AAPL_US_EQ", as_of)
    assert out == {"net_income": 1.0}


@pytest.mark.asyncio
async def test_empty_tickers_makes_no_call():
    """No tickers → no HTTP at all."""
    provider = _provider()
    # assert_all_called=False: registering the route while expecting it NOT to fire is the whole point.
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(f"{BASE_URL}/internal/api/fundamentals-pit").mock(
            return_value=httpx.Response(200, json={"fundamentals": {}})
        )
        out = await provider.fetch_many([], 1_600_100_000_000)
    assert out == {}
    assert route.call_count == 0


@pytest.mark.asyncio
async def test_503_cold_warehouse_degrades_to_empty():
    """A 503 (cold/unseeded warehouse) degrades to {} — NEVER raised into the cycle (so the router
    falls back to Yahoo)."""
    provider = _provider()
    as_of = 1_600_100_000_000
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            return_value=httpx.Response(503, json={"detail": "fundamentals read unavailable"})
        )
        out = await provider.fetch_many(["AAPL_US_EQ"], as_of)
    assert out == {}


@pytest.mark.asyncio
async def test_transport_error_degrades_to_empty():
    """A transport error (service down / DNS) degrades to {} — never raised."""
    provider = _provider()
    as_of = 1_600_100_000_000
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            side_effect=httpx.ConnectError("connection refused")
        )
        out = await provider.fetch_many(["AAPL_US_EQ"], as_of)
    assert out == {}


@pytest.mark.asyncio
async def test_malformed_json_degrades_to_empty():
    """A 200 with a non-JSON body degrades to {} — never raised."""
    provider = _provider()
    as_of = 1_600_100_000_000
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            return_value=httpx.Response(200, content=b"not json")
        )
        out = await provider.fetch_many(["AAPL_US_EQ"], as_of)
    assert out == {}


@pytest.mark.asyncio
async def test_structurally_malformed_payload_degrades_to_empty():
    """A 200 with VALID JSON but a structurally-wrong shape (a name mapping to a non-dict, or
    `fundamentals` not a dict) degrades to {} — the projection is inside the try, so the live cycle
    never crashes on an upstream shape regression (the parse-failure → {} contract)."""
    provider = _provider()
    as_of = 1_600_100_000_000
    # A name mapping to a string instead of a line-item dict.
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            return_value=httpx.Response(200, json={"fundamentals": {"AAPL_US_EQ": "garbage"}})
        )
        assert await provider.fetch_many(["AAPL_US_EQ"], as_of) == {}
    # `fundamentals` not a dict at all.
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/fundamentals-pit?tickers=AAPL_US_EQ&asOf={as_of}").mock(
            return_value=httpx.Response(200, json={"fundamentals": ["not", "a", "dict"]})
        )
        assert await provider.fetch_many(["AAPL_US_EQ"], as_of) == {}


def test_source_for_routes_by_jurisdiction():
    """source_for stamps pit-edgar (US) / pit-companies-house (UK)."""
    provider = _provider()
    assert provider.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR
    assert provider.source_for("HSBAl_EQ") == SOURCE_PIT_COMPANIES_HOUSE
