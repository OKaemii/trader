"""OpenFIGI mapping client tests — pure parser + batching + fail-soft, against fixtures.

Response fixtures mirror the live v3 `/mapping` shape (verified against `api.openfigi.com`): a
parallel array, each element `{"data":[{figi, name, ticker, exchCode, compositeFIGI, securityType,
…}]}` for a hit or `{"error":…}`/empty for a miss. No live network: parsing is a total function and
the I/O path runs through an httpx `MockTransport`."""
from __future__ import annotations

import pytest

from src.security_master.openfigi import (
    OpenFigiClient,
    _MappingJob,
    parse_mapping_response,
)
from src.security_master.rate_limiter import RateLimiter
from tests.fakes import httpx_transport

# Live-shape mapping response for [AAPL, MSFT] (figi values are the real composite FIGIs).
AAPL_MSFT_RESPONSE = [
    {"data": [{"figi": "BBG000B9XRY4", "name": "APPLE INC", "ticker": "AAPL", "exchCode": "US",
               "compositeFIGI": "BBG000B9XRY4", "securityType": "Common Stock",
               "marketSector": "Equity", "shareClassFIGI": "BBG001S5N8V8"}]},
    {"data": [{"figi": "BBG000BPH459", "name": "MICROSOFT CORP", "ticker": "MSFT", "exchCode": "US",
               "compositeFIGI": "BBG000BPH459", "securityType": "Common Stock"}]},
]


def _jobs(*tickers: str) -> list[_MappingJob]:
    return [_MappingJob(query_ticker=t, id_type="TICKER", id_value=t, exch_code="US") for t in tickers]


# ── parse_mapping_response ───────────────────────────────────────────────────
def test_parse_mapping_positional_association() -> None:
    mapped = parse_mapping_response(AAPL_MSFT_RESPONSE, _jobs("AAPL", "MSFT"))
    assert [m.query_ticker for m in mapped] == ["AAPL", "MSFT"]
    assert mapped[0].figi == "BBG000B9XRY4"
    assert mapped[0].composite_figi == "BBG000B9XRY4"
    assert mapped[0].security_type == "Common Stock"
    assert mapped[1].composite_figi == "BBG000BPH459"


def test_parse_mapping_handles_error_and_empty_elements() -> None:
    response = [
        {"data": [{"figi": "BBG000B9XRY4", "compositeFIGI": "BBG000B9XRY4"}]},
        {"error": "No identifier found."},
        {},                                   # empty / no data
    ]
    mapped = parse_mapping_response(response, _jobs("AAPL", "NOPE", "ALSONOPE"))
    assert mapped[0].composite_figi == "BBG000B9XRY4"
    # Misses come back all-None (never fabricated).
    assert mapped[1].figi is None and mapped[1].composite_figi is None
    assert mapped[2].figi is None


def test_parse_mapping_short_response_pads_with_none() -> None:
    # Fewer response elements than jobs (a truncated body): the missing tail is all-None, never an
    # index error.
    mapped = parse_mapping_response([{"data": [{"figi": "F1", "compositeFIGI": "C1"}]}], _jobs("A", "B", "C"))
    assert mapped[0].composite_figi == "C1"
    assert mapped[1].composite_figi is None and mapped[2].composite_figi is None


# ── client batching + I/O ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_map_tickers_preserves_order_through_transport() -> None:
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read().decode()
        assert '"idType": "TICKER"' in body or '"idType":"TICKER"' in body
        return httpx.Response(200, json=AAPL_MSFT_RESPONSE)

    client = OpenFigiClient(api_key="", transport=httpx_transport(handler), limiter=RateLimiter(1000, 1.0))
    mapped = await client.map_tickers(["AAPL", "MSFT"], exch_code="US")
    assert [m.query_ticker for m in mapped] == ["AAPL", "MSFT"]
    assert mapped[0].composite_figi == "BBG000B9XRY4"


@pytest.mark.asyncio
async def test_map_tickers_chunks_to_batch_size() -> None:
    import httpx

    # Force a tiny batch via a keyless client and patch the batch size to 1 so 2 tickers ⇒ 2 requests.
    client = OpenFigiClient(api_key="", transport=None, limiter=RateLimiter(1000, 1.0))
    client._batch_size = 1
    requests_seen: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.read()
        import json as _json
        n = len(_json.loads(body))
        requests_seen.append(n)
        # Echo a single-record response so each 1-job request maps cleanly.
        return httpx.Response(200, json=[{"data": [{"figi": "F", "compositeFIGI": "C"}]}])

    client._transport = httpx_transport(handler)
    mapped = await client.map_tickers(["AAPL", "MSFT"])
    assert requests_seen == [1, 1]            # two separate batched requests
    assert len(mapped) == 2


@pytest.mark.asyncio
async def test_map_tickers_fail_soft_returns_none_mappings() -> None:
    import httpx

    def handler_500(request):
        return httpx.Response(429, text="rate limited")

    client = OpenFigiClient(api_key="", transport=httpx_transport(handler_500), limiter=RateLimiter(1000, 1.0))
    mapped = await client.map_tickers(["AAPL", "MSFT"])
    # Length still matches input; every mapping is all-None (no fabrication, no raise).
    assert len(mapped) == 2
    assert all(m.figi is None and m.composite_figi is None for m in mapped)


@pytest.mark.asyncio
async def test_map_ticker_single_returns_none_on_miss() -> None:
    import httpx

    def handler(request):
        return httpx.Response(200, json=[{"error": "No identifier found."}])

    client = OpenFigiClient(api_key="", transport=httpx_transport(handler), limiter=RateLimiter(1000, 1.0))
    assert await client.map_ticker("NOPE") is None


def test_keyed_client_uses_larger_batch() -> None:
    keyed = OpenFigiClient(api_key="secret-key")
    unkeyed = OpenFigiClient(api_key="")
    assert keyed.batch_size == 100
    assert unkeyed.batch_size == 10
