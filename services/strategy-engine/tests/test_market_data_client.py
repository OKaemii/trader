"""
Tests for MarketDataClient. Mocks the HTTP layer via respx — no network, no
market-data-service required. Pins:
  - HS256 JWT shape matches packages/shared-auth/src/internal-jwt.ts (so the
    server-side parseInternalHeaders accepts it)
  - Auth header is `Authorization: Bearer <jwt>` (not the old X-Internal-Token)
  - URLs target the post-refactor /internal/api/market-data/bars/* paths
  - Per-cycle cache: same (ticker, interval, range) within one cycle = no second HTTP call
  - start_cycle() clears the cache across cycles
  - Batch endpoint coalesces multiple tickers into one round-trip
  - Missing tickers in the response are absent from the returned dict (caller's signal
    that the ticker has no history yet — strategies treat as "skip")
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json

import httpx
import pytest
import respx

from src.infrastructure.market_data_client import MarketDataClient, mint_internal_jwt


SECRET = "test-jwt-secret"
BASE_URL = "http://market-data-service:3002"


def _bar(ts: int, close: float) -> dict:
    return {
        "ticker": "AAPL_US_EQ", "timestamp": ts, "interval": "daily",
        "open": close, "high": close, "low": close, "close": close, "volume": 100,
    }


def _verify_jwt(token: str, secret: str = SECRET, caller: str = "strategy-engine") -> bool:
    """Mirror of parseInternalHeaders — verifies HS256 signature + caller claim."""
    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
        signing_input = f"{header_b64}.{payload_b64}".encode()
        expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
        # base64url decode (re-pad first)
        def _decode(s: str) -> bytes:
            pad = 4 - (len(s) % 4)
            return base64.urlsafe_b64decode(s + ("=" * pad if pad < 4 else ""))
        if not hmac.compare_digest(_decode(sig_b64), expected):
            return False
        payload = json.loads(_decode(payload_b64))
        return payload.get("sub") == caller and payload.get("aud") == "internal"
    except Exception:
        return False


def _bearer(request: httpx.Request) -> str:
    header = request.headers.get("Authorization", "")
    return header[len("Bearer "):] if header.startswith("Bearer ") else ""


@pytest.mark.asyncio
async def test_fetch_bars_signs_jwt_correctly():
    """Token must validate against the shared HS256 JWT scheme so the server accepts it."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")

    captured: list[str] = []
    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(_bearer(request))
        return httpx.Response(200, json={"ticker": "AAPL_US_EQ", "interval": "daily", "range": "30d", "bars": []})

    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/market-data/bars/AAPL_US_EQ?interval=daily&range=30d").mock(side_effect=handler)
        await client.fetch_bars("AAPL_US_EQ")

    assert len(captured) == 1
    assert _verify_jwt(captured[0]), f"server-side JWT check failed for token: {captured[0]}"


@pytest.mark.asyncio
async def test_mint_internal_jwt_shape():
    """Standalone mint helper produces parseable HS256 JWTs with the expected claims."""
    token = mint_internal_jwt("strategy-engine", SECRET)
    assert token.count(".") == 2
    assert _verify_jwt(token)


@pytest.mark.asyncio
async def test_fetch_bars_returns_parsed_bars():
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    client.start_cycle("c1")
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/market-data/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
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
        route = mock.get(f"{BASE_URL}/internal/api/market-data/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
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
        route = mock.get(f"{BASE_URL}/internal/api/market-data/bars/AAPL_US_EQ?interval=daily&range=30d").mock(
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
        mock.post(f"{BASE_URL}/internal/api/market-data/bars").mock(
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
        first = mock.post(f"{BASE_URL}/internal/api/market-data/bars").mock(
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
        mock.post(f"{BASE_URL}/internal/api/market-data/bars").mock(
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
        route = mock.post(f"{BASE_URL}/internal/api/market-data/bars")
        result = await client.fetch_bars_batch([])
    assert result == {}
    assert route.call_count == 0


# ── fetch_sectors ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_fetch_sectors_returns_ticker_to_sector_map():
    """Happy path — server returns {sectors, fetchedAt}, client returns just the sectors."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/universe/sectors").mock(
            return_value=httpx.Response(200, json={
                "sectors": {
                    "AAPL_US_EQ": "Technology",
                    "SHELl_EQ":   "Energy",
                    "NEW_US_EQ":  "Unknown",
                },
                "fetchedAt": 1_700_000_000_000,
            }),
        )
        sectors = await client.fetch_sectors()

    assert sectors == {
        "AAPL_US_EQ": "Technology",
        "SHELl_EQ":   "Energy",
        "NEW_US_EQ":  "Unknown",
    }


@pytest.mark.asyncio
async def test_fetch_sectors_signs_jwt_correctly():
    """Same JWT scheme as fetch_bars — defence in depth against auth drift."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)

    captured: list[str] = []
    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(_bearer(request))
        return httpx.Response(200, json={"sectors": {}, "fetchedAt": 0})

    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/universe/sectors").mock(side_effect=handler)
        await client.fetch_sectors()

    assert len(captured) == 1
    assert _verify_jwt(captured[0])


@pytest.mark.asyncio
async def test_fetch_sectors_handles_empty_sectors_object():
    """Cold-start state — server returns {sectors: {}, fetchedAt: 0}. Client returns {}."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/universe/sectors").mock(
            return_value=httpx.Response(200, json={"sectors": {}, "fetchedAt": 0}),
        )
        sectors = await client.fetch_sectors()
    assert sectors == {}


@pytest.mark.asyncio
async def test_fetch_sectors_raises_on_http_error():
    """Network/upstream failures bubble up so the engine host can decide what to do."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    with respx.mock() as mock:
        mock.get(f"{BASE_URL}/internal/api/universe/sectors").mock(
            return_value=httpx.Response(500),
        )
        with pytest.raises(httpx.HTTPStatusError):
            await client.fetch_sectors()


@pytest.mark.asyncio
async def test_fetch_sectors_returns_defensive_copy():
    """Caller mutating the returned dict must NOT leak into the next call."""
    client = MarketDataClient(base_url=BASE_URL, secret=SECRET)
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{BASE_URL}/internal/api/universe/sectors").mock(
            return_value=httpx.Response(200, json={
                "sectors": {"AAPL_US_EQ": "Technology"},
                "fetchedAt": 1_700_000_000_000,
            }),
        )
        first = await client.fetch_sectors()
        first["MUTATED"] = "Junk"   # caller pollutes the returned dict

        second = await client.fetch_sectors()
        assert "MUTATED" not in second
        assert second == {"AAPL_US_EQ": "Technology"}
