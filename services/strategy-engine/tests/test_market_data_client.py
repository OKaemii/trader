"""
Tests for MarketDataClient. Mocks the HTTP layer via respx — no network, no
market-data-service required. Pins:
  - HMAC token shape matches packages/shared-auth/src/internal-token.ts (so the
    server-side validateInternalToken accepts it)
  - Per-cycle cache: same (ticker, interval, range) within one cycle = no second HTTP call
  - start_cycle() clears the cache across cycles
  - Batch endpoint coalesces multiple tickers into one round-trip
  - Missing tickers in the response are absent from the returned dict (caller's signal
    that the ticker has no history yet — strategies treat as "skip")
"""
from __future__ import annotations

import hmac
import hashlib
import json

import httpx
import pytest
import respx

from src.infrastructure.market_data_client import MarketDataClient


SECRET = "test-internal-secret"
BASE_URL = "http://market-data-service:3002"


def _bar(ts: int, close: float) -> dict:
    return {
        "ticker": "AAPL_US_EQ", "timestamp": ts, "interval": "daily",
        "open": close, "high": close, "low": close, "close": close, "volume": 100,
    }


def _verify_token(token: str, caller: str = "strategy-engine") -> bool:
    """Mirror of validateInternalToken — used in assertions."""
    try:
        ts_str, mac = token.split(".")
        expected = hmac.new(SECRET.encode(), f"{caller}:{ts_str}".encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(mac, expected)
    except Exception:
        return False


@pytest.mark.asyncio
async def test_fetch_bars_signs_token_correctly():
    """Token must validate against the shared HMAC scheme so the server accepts it."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")

    captured_token: list[str] = []
    async def handler(request: httpx.Request) -> httpx.Response:
        captured_token.append(request.headers.get("X-Internal-Token", ""))
        return httpx.Response(200, json={"ticker": "AAPL_US_EQ", "interval": "daily", "range": "30d", "bars": []})

    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/bars/AAPL_US_EQ?interval=daily&range=30d").mock(side_effect=handler)
        await client.fetch_bars("AAPL_US_EQ")

    assert len(captured_token) == 1
    assert _verify_token(captured_token[0]), f"server-side HMAC check failed for token: {captured_token[0]}"


@pytest.mark.asyncio
async def test_fetch_bars_returns_parsed_bars():
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
            return_value=httpx.Response(200, json={
                "ticker": "AAPL_US_EQ", "interval": "daily", "range": "30d",
                "bars": [_bar(1000, 100), _bar(2000, 101), _bar(3000, 102)],
            }),
        )
        bars = await client.fetch_bars("AAPL_US_EQ")
    assert [b.close for b in bars] == [100.0, 101.0, 102.0]
    assert [b.timestamp for b in bars] == [1000, 2000, 3000]
    assert bars[0].ticker == "AAPL_US_EQ"


@pytest.mark.asyncio
async def test_per_cycle_cache_hits_dont_hit_http():
    """Two fetches for the same key within one cycle → one HTTP call."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        route = mock.get(f"{BASE_URL}/internal/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
            return_value=httpx.Response(200, json={"ticker": "AAPL_US_EQ", "interval": "daily", "range": "30d", "bars": [_bar(1, 1.0)]}),
        )
        await client.fetch_bars("AAPL_US_EQ")
        await client.fetch_bars("AAPL_US_EQ")
    assert route.call_count == 1


@pytest.mark.asyncio
async def test_start_cycle_clears_cache_across_cycles():
    """A new cycle must re-fetch — strategy data shouldn't be stuck on yesterday's bars."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        route = mock.get(f"{BASE_URL}/internal/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
            return_value=httpx.Response(200, json={"ticker": "AAPL_US_EQ", "interval": "daily", "range": "30d", "bars": [_bar(1, 1.0)]}),
        )
        await client.fetch_bars("AAPL_US_EQ")
        client.start_cycle("c2")
        await client.fetch_bars("AAPL_US_EQ")
    assert route.call_count == 2


@pytest.mark.asyncio
async def test_batch_fetch_returns_map_keyed_by_ticker():
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        mock.post(f"{BASE_URL}/internal/bars").mock(
            return_value=httpx.Response(200, json={
                "interval": "daily", "range": "30d",
                "bars": {
                    "AAPL_US_EQ": [_bar(1, 100.0), _bar(2, 101.0)],
                    "MSFT_US_EQ": [_bar(1, 300.0)],
                },
            }),
        )
        result = await client.fetch_bars_batch(["AAPL_US_EQ", "MSFT_US_EQ"])
    assert set(result.keys()) == {"AAPL_US_EQ", "MSFT_US_EQ"}
    assert [b.close for b in result["AAPL_US_EQ"]] == [100.0, 101.0]
    assert [b.close for b in result["MSFT_US_EQ"]] == [300.0]


@pytest.mark.asyncio
async def test_batch_fetch_skips_already_cached_tickers():
    """Mixed batch: some tickers are in cache, some aren't. HTTP only sees the misses."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        # First call: prime the cache for AAPL only
        first = mock.post(f"{BASE_URL}/internal/bars").mock(
            return_value=httpx.Response(200, json={"interval": "daily", "range": "30d", "bars": {"AAPL_US_EQ": [_bar(1, 100.0)]}}),
        )
        await client.fetch_bars_batch(["AAPL_US_EQ"])
        assert first.call_count == 1

        # Second call: AAPL cached, MSFT missing → only MSFT goes over the wire
        captured: list[dict] = []
        async def handler(request: httpx.Request) -> httpx.Response:
            captured.append(json.loads(request.content))
            return httpx.Response(200, json={"interval": "daily", "range": "30d", "bars": {"MSFT_US_EQ": [_bar(1, 300.0)]}})
        first.mock(side_effect=handler)
        result = await client.fetch_bars_batch(["AAPL_US_EQ", "MSFT_US_EQ"])

    assert result["AAPL_US_EQ"][0].close == 100.0
    assert result["MSFT_US_EQ"][0].close == 300.0
    # The wire payload should ask for MSFT only, not both.
    assert captured[0]["tickers"] == ["MSFT_US_EQ"]


@pytest.mark.asyncio
async def test_batch_fetch_returns_no_entry_for_missing_tickers():
    """A ticker the server doesn't know about must be absent from the result dict,
    not present with []. Strategies use `len(history(t)) >= window` as their gate —
    an empty list would silently look the same as "had bars but all stale," masking
    universe-resolution bugs."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        mock.post(f"{BASE_URL}/internal/bars").mock(
            return_value=httpx.Response(200, json={"interval": "daily", "range": "30d", "bars": {"AAPL_US_EQ": [_bar(1, 100.0)]}}),
        )
        result = await client.fetch_bars_batch(["AAPL_US_EQ", "UNKNOWN_TICKER"])
    assert "UNKNOWN_TICKER" not in result
    assert "AAPL_US_EQ" in result


@pytest.mark.asyncio
async def test_batch_fetch_empty_tickers_returns_empty_dict_no_http():
    """Calling with [] must not waste an HTTP round-trip."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    # assert_all_called=False so we can declare the route purely to count calls without
    # respx flagging the never-called route as a test failure.
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post(f"{BASE_URL}/internal/bars")
        result = await client.fetch_bars_batch([])
    assert result == {}
    assert route.call_count == 0
