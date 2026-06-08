"""Tests for the FundamentalsAsOf seam + forward-only Yahoo impl (PIT socket).

Pins the contract Task 9 depends on:
  - market routing by suffix (`_US_EQ`→US/future-EDGAR, `l_EQ`→UK/future-Companies-House);
  - FORWARD-ONLY honesty: a PAST `as_of_ms` returns `{}` (so historical Quality/Value stay None
    — never a look-ahead proxy); a ≈`now` `as_of_ms` returns the live snapshot line items;
  - the returned dict carries the snake_case keys QualityFactor/ValueFactor read off
    `HistoryView.fundamentals[t]`, and only emits the optional margin/stability/yield legs when
    the snapshot actually supplies them (a missing leg is omitted, NOT a fabricated 0);
  - the `source` stamp is `yahoo-snapshot`.

The seam's job is the forward-only gate + the field mapping; the underlying Yahoo HTTP call is
MarketDataClient.fetch_fundamentals' concern (covered in test_market_data_client.py). So these
tests inject a fake client and assert the seam never calls it for a past as_of and maps the
snapshot rows to the factor keys for a ≈now as_of — no HTTP, no extra test dependency.
"""
from __future__ import annotations

import time

import pytest

from src.infrastructure.fundamentals_as_of import (
    FORWARD_ONLY_TOLERANCE_MS,
    MARKET_OTHER,
    MARKET_UK,
    MARKET_US,
    PROVIDER_MODE_PIT,
    PROVIDER_MODE_YAHOO,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    SOURCE_YAHOO_SNAPSHOT,
    PitFundamentalsAsOf,
    RoutingFundamentalsAsOf,
    YahooFundamentalsAsOf,
    _pit_line_items,
    build_fundamentals_provider,
    market_of,
)


def _now_ms() -> int:
    return int(time.time() * 1000)


class _FakeClient:
    """Stand-in for MarketDataClient: returns a canned snapshot and counts calls, so we can
    assert the seam short-circuits before the upstream Yahoo fetch on a past as_of."""

    def __init__(self, snapshot: dict[str, dict[str, float]]) -> None:
        self._snapshot = snapshot
        self.calls = 0

    async def fetch_fundamentals(self, tickers: list[str]) -> dict[str, dict[str, float]]:
        self.calls += 1
        return {t: self._snapshot[t] for t in tickers if t in self._snapshot}


# The snake_case rows MarketDataClient.fetch_fundamentals produces. This QMJ snapshot carries the
# balance-sheet/income items only — gross_profit/total_revenue/earnings_stability/dividend_yield
# are absent, so the seam must OMIT them (not default to 0).
_QMJ_SNAPSHOT = {
    "AAPL_US_EQ": {
        "market_cap_gbp": 2.4e12,
        "net_income": 9.9e10,
        "total_equity": 6.2e10,
        "total_debt": 1.1e11,
        "current_assets": 1.4e11,
        "current_liabilities": 1.3e11,
    },
}


def test_market_routing_by_suffix():
    """The future PIT source is selected by the T212 ticker suffix."""
    assert market_of("AAPL_US_EQ") == MARKET_US
    assert market_of("HSBAl_EQ") == MARKET_UK
    assert market_of("SOMECRYPTO") == MARKET_OTHER


@pytest.mark.asyncio
async def test_past_as_of_returns_empty_forward_only():
    """A PAST as_of_ms must resolve to {} — the snapshot describes 'now', and fabricating a
    historical value would be look-ahead. The upstream fetch is not even called."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    past = _now_ms() - 365 * 24 * 60 * 60 * 1000  # one year ago
    result = await provider.fetch("AAPL_US_EQ", past)
    assert result == {}
    assert client.calls == 0  # forward-only short-circuits before the upstream call


@pytest.mark.asyncio
async def test_just_outside_tolerance_returns_empty():
    """The boundary: an as_of just older than the tolerance is still refused."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    stale = _now_ms() - FORWARD_ONLY_TOLERANCE_MS - 60_000
    result = await provider.fetch("AAPL_US_EQ", stale)
    assert result == {}
    assert client.calls == 0


@pytest.mark.asyncio
async def test_now_as_of_returns_snapshot_line_items():
    """A ≈now as_of returns the live snapshot mapped to the snake_case keys the factors read."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    result = await provider.fetch("AAPL_US_EQ", _now_ms())
    assert client.calls == 1
    # The balance-sheet/income keys QualityFactor + ValueFactor's earnings/book legs read.
    assert result["market_cap_gbp"] == pytest.approx(2.4e12)
    assert result["net_income"] == pytest.approx(9.9e10)
    assert result["total_equity"] == pytest.approx(6.2e10)
    assert result["total_debt"] == pytest.approx(1.1e11)
    # Optional legs absent from this snapshot must be OMITTED, not defaulted to 0 (a 0 margin/
    # yield would be a false signal the factor would z-score against).
    assert "earnings_stability" not in result
    assert "dividend_yield" not in result
    assert "gross_profit" not in result
    assert "total_revenue" not in result


@pytest.mark.asyncio
async def test_now_as_of_emits_optional_legs_when_present():
    """When the snapshot carries gross_profit/total_revenue/earnings_stability/dividend_yield,
    they flow through to the factor dict (the future richer-snapshot / PIT case)."""
    snapshot = {
        "AAPL_US_EQ": {
            "market_cap_gbp": 2.4e12,
            "net_income": 9.9e10,
            "total_equity": 6.2e10,
            "total_debt": 1.1e11,
            "gross_profit": 1.7e11,
            "total_revenue": 3.9e11,
            "earnings_stability": 0.82,
            "dividend_yield": 0.005,
        },
    }
    client = _FakeClient(snapshot)
    provider = YahooFundamentalsAsOf(client)
    result = await provider.fetch("AAPL_US_EQ", _now_ms())
    assert result["gross_profit"] == pytest.approx(1.7e11)
    assert result["total_revenue"] == pytest.approx(3.9e11)
    assert result["earnings_stability"] == pytest.approx(0.82)
    assert result["dividend_yield"] == pytest.approx(0.005)


@pytest.mark.asyncio
async def test_fetch_many_past_as_of_empty_no_call():
    """Batch form is forward-only too: a past as_of returns {} for ALL names, no upstream call."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    past = _now_ms() - 365 * 24 * 60 * 60 * 1000
    result = await provider.fetch_many(["AAPL_US_EQ", "HSBAl_EQ"], past)
    assert result == {}
    assert client.calls == 0


@pytest.mark.asyncio
async def test_fetch_many_empty_tickers_no_call():
    """No tickers → no upstream call, even at ≈now."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    result = await provider.fetch_many([], _now_ms())
    assert result == {}
    assert client.calls == 0


@pytest.mark.asyncio
async def test_fetch_many_now_maps_each_present_name():
    """≈now batch returns one mapped row per name the snapshot has; absent names are omitted."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    result = await provider.fetch_many(["AAPL_US_EQ", "MISSING_US_EQ"], _now_ms())
    assert set(result.keys()) == {"AAPL_US_EQ"}
    assert result["AAPL_US_EQ"]["net_income"] == pytest.approx(9.9e10)


def test_source_stamp_is_yahoo_snapshot():
    """The source stamp persisted in factor_scores names this provider's origin."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = YahooFundamentalsAsOf(client)
    assert provider.source_for("AAPL_US_EQ") == SOURCE_YAHOO_SNAPSHOT
    assert provider.source_for("HSBAl_EQ") == SOURCE_YAHOO_SNAPSHOT


# ── Task 14: routing provider + PIT line-item projection + provider build (deps-light, no HTTP) ──
#
# These pin the live-seam wiring: RoutingFundamentalsAsOf delegates by market_of() to a PIT provider
# for US/UK and Yahoo for OTHER, falls back to Yahoo on a PIT miss, and never injects a Yahoo proxy
# into replay (forward-only Yahoo returns {} for a past as_of). The HTTP behaviour of the concrete
# PitFundamentalsAsOf is covered separately (respx) in test_pit_fundamentals_http.py.


class _FakePit:
    """Stand-in for PitFundamentalsAsOf: returns a canned per-ticker map, records the tickers asked
    for, and stamps pit-edgar/pit-companies-house by suffix — so we can assert the router queries PIT
    with exactly the US/UK slice and stamps the jurisdiction source."""

    def __init__(self, by_ticker: dict[str, dict[str, float]]) -> None:
        self._by_ticker = by_ticker
        self.asked: list[str] = []

    def source_for(self, ticker: str) -> str:
        return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR

    async def fetch_many(self, tickers, as_of_ms):
        self.asked = list(tickers)
        return {t: self._by_ticker[t] for t in tickers if t in self._by_ticker}

    async def fetch(self, ticker, as_of_ms):
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


class _FakeYahooProvider:
    """Stand-in for YahooFundamentalsAsOf at the provider level (not the client): forward-only — a
    past as_of returns {} for ALL names; ≈now returns the canned rows. Records which names it was
    asked for so we can prove the router only sends OTHER + PIT-miss names to Yahoo."""

    def __init__(self, by_ticker: dict[str, dict[str, float]]) -> None:
        self._by_ticker = by_ticker
        self.asked: list[str] = []

    def source_for(self, ticker: str) -> str:
        return SOURCE_YAHOO_SNAPSHOT

    async def fetch_many(self, tickers, as_of_ms):
        self.asked = list(tickers)
        if (_now_ms() - as_of_ms) > FORWARD_ONLY_TOLERANCE_MS:  # forward-only: past as_of → {}
            return {}
        return {t: self._by_ticker[t] for t in tickers if t in self._by_ticker}

    async def fetch(self, ticker, as_of_ms):
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


@pytest.mark.asyncio
async def test_routing_sends_us_uk_to_pit_other_to_yahoo():
    """The router queries PIT with exactly the US/UK slice and Yahoo with the OTHER slice."""
    pit = _FakePit({"AAPL_US_EQ": {"net_income": 1.0}, "HSBAl_EQ": {"net_income": 2.0}})
    yahoo = _FakeYahooProvider({"BTC_OTHER": {"net_income": 3.0}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    result = await router.fetch_many(["AAPL_US_EQ", "HSBAl_EQ", "BTC_OTHER"], _now_ms())
    # PIT got the US + UK names; Yahoo got only the OTHER name (no PIT misses to fall back).
    assert set(pit.asked) == {"AAPL_US_EQ", "HSBAl_EQ"}
    assert yahoo.asked == ["BTC_OTHER"]
    assert result["AAPL_US_EQ"] == {"net_income": 1.0}
    assert result["HSBAl_EQ"] == {"net_income": 2.0}
    assert result["BTC_OTHER"] == {"net_income": 3.0}


@pytest.mark.asyncio
async def test_routing_pit_miss_falls_back_to_yahoo_live():
    """A US name PIT has no fact for (empty PIT result) falls back to the Yahoo snapshot in live
    (≈now). The router sends the PIT-miss name to Yahoo alongside the OTHER slice."""
    pit = _FakePit({})  # PIT covers nothing yet (pre-backfill)
    yahoo = _FakeYahooProvider({"AAPL_US_EQ": {"net_income": 9.9e10}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    result = await router.fetch_many(["AAPL_US_EQ"], _now_ms())
    assert pit.asked == ["AAPL_US_EQ"]          # PIT was tried first
    assert yahoo.asked == ["AAPL_US_EQ"]        # then fell back to Yahoo
    assert result["AAPL_US_EQ"] == {"net_income": 9.9e10}


@pytest.mark.asyncio
async def test_routing_pit_miss_no_yahoo_proxy_in_replay():
    """The fallback is LIVE-ONLY: for a PAST as_of, forward-only Yahoo returns {} — so a PIT miss
    yields NO value (never a look-ahead proxy in a backtest replay)."""
    pit = _FakePit({})
    yahoo = _FakeYahooProvider({"AAPL_US_EQ": {"net_income": 9.9e10}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    past = _now_ms() - 365 * 24 * 60 * 60 * 1000
    result = await router.fetch_many(["AAPL_US_EQ"], past)
    assert result == {}   # PIT empty (warehouse miss) + Yahoo forward-only → no proxy


@pytest.mark.asyncio
async def test_routing_pit_hit_does_not_call_yahoo_for_that_name():
    """A name PIT covers is NOT re-sent to Yahoo (no needless fallback / double source)."""
    pit = _FakePit({"AAPL_US_EQ": {"net_income": 1.0}})
    yahoo = _FakeYahooProvider({"AAPL_US_EQ": {"net_income": 9.9e10}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    result = await router.fetch_many(["AAPL_US_EQ"], _now_ms())
    assert yahoo.asked == []                       # nothing fell back
    assert result["AAPL_US_EQ"] == {"net_income": 1.0}   # the PIT value, not Yahoo's


def test_routing_source_for_defaults_to_jurisdiction_before_fetch():
    """Before any fetch, source_for reports the routed jurisdiction's stamp (the expected/covered case):
    pit-edgar (US), pit-companies-house (UK), yahoo-snapshot (OTHER)."""
    router = RoutingFundamentalsAsOf(_FakePit({}), _FakeYahooProvider({}))
    assert router.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR
    assert router.source_for("HSBAl_EQ") == SOURCE_PIT_COMPANIES_HOUSE
    assert router.source_for("BTC_OTHER") == SOURCE_YAHOO_SNAPSHOT


@pytest.mark.asyncio
async def test_routing_source_for_reflects_actual_yahoo_fallback():
    """Honest provenance: a US name PIT covered keeps pit-edgar; a US name that fell back to Yahoo
    (live) is stamped yahoo-snapshot — never mislabelled pit-* — after the fetch records the fallback."""
    pit = _FakePit({"AAPL_US_EQ": {"net_income": 1.0}})            # PIT covers AAPL only
    yahoo = _FakeYahooProvider({"MSFT_US_EQ": {"net_income": 2.0}})  # MSFT only on Yahoo
    router = RoutingFundamentalsAsOf(pit, yahoo)
    await router.fetch_many(["AAPL_US_EQ", "MSFT_US_EQ"], _now_ms())
    assert router.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR        # served from PIT
    assert router.source_for("MSFT_US_EQ") == SOURCE_YAHOO_SNAPSHOT   # served from Yahoo fallback


@pytest.mark.asyncio
async def test_routing_source_for_past_as_of_keeps_pit_stamp_no_proxy():
    """A PIT-miss at a PAST as_of is NOT a Yahoo fallback (forward-only Yahoo returns {}), so the name
    is absent from the result and source_for keeps the (unused) PIT jurisdiction default — no proxy,
    no mislabel into replay."""
    pit = _FakePit({})                                               # PIT covers nothing
    yahoo = _FakeYahooProvider({"AAPL_US_EQ": {"net_income": 9.9e10}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    past = _now_ms() - 365 * 24 * 60 * 60 * 1000
    result = await router.fetch_many(["AAPL_US_EQ"], past)
    assert result == {}                                              # no value (no proxy)
    assert router.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR       # not flagged as a Yahoo fallback


@pytest.mark.asyncio
async def test_routing_fallback_set_resets_between_fetches():
    """The fallback set is per-fetch: a name that fell back last cycle but is PIT-covered this cycle is
    re-stamped pit-* (no stale fallback flag leaks across cycles)."""
    pit = _FakePit({})
    yahoo = _FakeYahooProvider({"AAPL_US_EQ": {"net_income": 1.0}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    await router.fetch_many(["AAPL_US_EQ"], _now_ms())               # PIT miss → Yahoo fallback
    assert router.source_for("AAPL_US_EQ") == SOURCE_YAHOO_SNAPSHOT
    pit._by_ticker = {"AAPL_US_EQ": {"net_income": 2.0}}             # PIT now covers it
    await router.fetch_many(["AAPL_US_EQ"], _now_ms())
    assert router.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR       # re-stamped, no stale flag


@pytest.mark.asyncio
async def test_routing_empty_tickers_no_calls():
    """No tickers → neither provider is called."""
    pit = _FakePit({"AAPL_US_EQ": {"net_income": 1.0}})
    yahoo = _FakeYahooProvider({"BTC_OTHER": {"net_income": 3.0}})
    router = RoutingFundamentalsAsOf(pit, yahoo)
    assert await router.fetch_many([], _now_ms()) == {}
    assert pit.asked == [] and yahoo.asked == []


# ── PIT line-item projection (pure, no HTTP) ─────────────────────────────────────────────────────
def test_pit_line_items_keeps_only_finite_line_items():
    """The seam payload carries line items + provenance; the projection keeps only the LINE_ITEMS keys
    with a finite numeric value, drops provenance (source/observation_ts/knowledge_ts) and null/
    non-numeric line items (NaN-excluded, never a fabricated 0)."""
    payload = {
        "net_income": 9.9e10,
        "total_equity": 6.2e10,
        "current_assets": None,            # null line item → omitted (not a fabricated 0)
        "shares_outstanding": "16000000",  # numeric-as-string → coerced
        "gross_profit": "n/a",             # non-numeric → omitted
        "source": "pit-edgar",             # provenance → not a factor input, dropped
        "observation_ts": 123,
        "knowledge_ts": 456,
        "not_a_line_item": 1.0,            # outside LINE_ITEMS → dropped (contract pins the vocabulary)
    }
    out = _pit_line_items(payload)
    assert out["net_income"] == pytest.approx(9.9e10)
    assert out["total_equity"] == pytest.approx(6.2e10)
    assert out["shares_outstanding"] == pytest.approx(1.6e7)
    assert "current_assets" not in out
    assert "gross_profit" not in out
    assert "source" not in out and "observation_ts" not in out and "knowledge_ts" not in out
    assert "not_a_line_item" not in out


def test_pit_line_items_empty_payload_is_empty():
    assert _pit_line_items({}) == {}


# ── build_fundamentals_provider — the wiring point's mode selection (reversibility) ──────────────
def test_build_provider_yahoo_mode_is_bare_yahoo():
    """mode='yahoo' (the safe default) returns the bare forward-only YahooFundamentalsAsOf — the
    pre-Task-14 behaviour. PIT is NOT constructed, so a `yahoo` deploy never touches fundamentals-api."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = build_fundamentals_provider(client, mode=PROVIDER_MODE_YAHOO)
    assert isinstance(provider, YahooFundamentalsAsOf)


def test_build_provider_default_mode_is_yahoo(monkeypatch):
    """No mode + no env ⇒ yahoo (the reversible safe default): pre-backfill the PIT warehouse is empty,
    so the live cycle gains nothing from routing through it."""
    monkeypatch.delenv("LIVE_FUNDAMENTALS_PROVIDER", raising=False)
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = build_fundamentals_provider(client)
    assert isinstance(provider, YahooFundamentalsAsOf)


def test_build_provider_env_pit_routes(monkeypatch):
    """LIVE_FUNDAMENTALS_PROVIDER=pit ⇒ a RoutingFundamentalsAsOf (US/UK→PIT, Yahoo fallback)."""
    monkeypatch.setenv("LIVE_FUNDAMENTALS_PROVIDER", "PIT")  # case-insensitive
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = build_fundamentals_provider(client, pit_provider=_FakePit({}))
    assert isinstance(provider, RoutingFundamentalsAsOf)


def test_build_provider_explicit_pit_mode_routes():
    """mode='pit' (explicit) ⇒ RoutingFundamentalsAsOf, regardless of env."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = build_fundamentals_provider(client, mode=PROVIDER_MODE_PIT, pit_provider=_FakePit({}))
    assert isinstance(provider, RoutingFundamentalsAsOf)


def test_build_provider_unknown_mode_falls_back_to_yahoo():
    """An unrecognised mode is treated as yahoo (fail-safe: never route to PIT on a typo)."""
    client = _FakeClient(_QMJ_SNAPSHOT)
    provider = build_fundamentals_provider(client, mode="garbage")
    assert isinstance(provider, YahooFundamentalsAsOf)
