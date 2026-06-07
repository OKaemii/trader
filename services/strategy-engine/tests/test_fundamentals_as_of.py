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
    SOURCE_YAHOO_SNAPSHOT,
    YahooFundamentalsAsOf,
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
