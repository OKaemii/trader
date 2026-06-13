"""Tests for the FundamentalsAsOf seam — the PIT-only socket (Thread C, Yahoo removed).

Pins the contract the research-factor layer depends on:
  - market routing by suffix (`_US_EQ`→US, `l_EQ`→UK, else OTHER) — the classifier the seam routes on;
  - FAIL-CLOSED: the seam reads ONLY the PIT lake (SEC EDGAR). A non-US name resolves to `{}` (no
    EDGAR, no Yahoo substitute — decision H); a US name the lake has no fact for ≤ asOf is omitted
    (a miss → `{}`). There is NO Yahoo fallback anywhere on this path;
  - the payload→line-item projection (`_pit_line_items`): keep only the snake_case `LINE_ITEMS` keys
    with a finite value, drop the provenance triple (source/observation_ts/knowledge_ts) and any
    null/non-numeric leg (NaN-excluded downstream, never a fabricated 0);
  - the wiring: `build_fundamentals_provider()` always returns the `PitFundamentalsAsOf` (PIT-only),
    `resolve_provider_mode()` always returns `pit`.

The concrete HTTP behaviour of `PitFundamentalsAsOf` (URL shape, JWT, degrade-to-{} on outage, the
non-US-makes-no-call routing) is covered against respx in test_pit_fundamentals_http.py; this file is
the deps-light projection/build twin (no HTTP, no extra test dependency).
"""
from __future__ import annotations

import pytest

from src.infrastructure.fundamentals_as_of import (
    MARKET_OTHER,
    MARKET_UK,
    MARKET_US,
    PROVIDER_MODE_PIT,
    SOURCE_PIT_EDGAR,
    PitFundamentalsAsOf,
    _pit_line_items,
    build_fundamentals_provider,
    market_of,
    resolve_provider_mode,
)


def test_market_routing_by_suffix():
    """The PIT source is selected by the T212 ticker suffix; UK/OTHER fail-closed downstream."""
    assert market_of("AAPL_US_EQ") == MARKET_US
    assert market_of("HSBAl_EQ") == MARKET_UK
    assert market_of("SOMECRYPTO") == MARKET_OTHER


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


def test_pit_line_items_non_dict_payload_is_empty():
    """A non-dict payload (a name mapping to a string/list/None in a malformed response) yields no line
    items — never an AttributeError into the live cycle."""
    assert _pit_line_items("garbage") == {}      # type: ignore[arg-type]
    assert _pit_line_items(None) == {}            # type: ignore[arg-type]
    assert _pit_line_items(["not", "a", "dict"]) == {}   # type: ignore[arg-type]


# ── PIT provider fail-closed routing (deps-light: non-US makes no HTTP) ───────────────────────────
@pytest.mark.asyncio
async def test_fetch_many_non_us_only_is_fail_closed_no_call():
    """A batch of only non-US names resolves to `{}` WITHOUT any HTTP — fail-closed (no EDGAR, no Yahoo
    substitute). A deliberately-unroutable base URL proves no request is attempted (a real call would
    raise/connect-error; the {} comes from the market short-circuit, not a degrade)."""
    provider = PitFundamentalsAsOf(base_url="http://255.255.255.255:1", secret="x", timeout=0.01)
    out = await provider.fetch_many(["HSBAl_EQ", "SOMECRYPTO"], 1_700_000_000_000)
    assert out == {}


@pytest.mark.asyncio
async def test_fetch_many_empty_tickers_is_empty_no_call():
    """No tickers → `{}` with no round-trip (the unreachable URL is never hit)."""
    provider = PitFundamentalsAsOf(base_url="http://255.255.255.255:1", secret="x", timeout=0.01)
    assert await provider.fetch_many([], 1_700_000_000_000) == {}


def test_source_for_is_always_pit_edgar():
    """source_for stamps pit-edgar — the only jurisdiction the lake serves. A non-US name never gets a
    fact (fail-closed `{}` → quality factor None → no source attached), so the default is harmless."""
    provider = PitFundamentalsAsOf(base_url="http://fundamentals-api:8011", secret="x")
    assert provider.source_for("AAPL_US_EQ") == SOURCE_PIT_EDGAR
    assert provider.source_for("HSBAl_EQ") == SOURCE_PIT_EDGAR


# ── build_fundamentals_provider — the wiring point (PIT-only) ─────────────────────────────────────
def test_build_provider_is_pit_only(monkeypatch):
    """The wiring is PIT-only: build_fundamentals_provider() returns the PitFundamentalsAsOf regardless
    of env (no Yahoo mode to select, no MarketDataClient needed)."""
    monkeypatch.delenv("LIVE_FUNDAMENTALS_PROVIDER", raising=False)
    assert isinstance(build_fundamentals_provider(), PitFundamentalsAsOf)


def test_build_provider_inert_to_stale_yahoo_env(monkeypatch):
    """A stale `LIVE_FUNDAMENTALS_PROVIDER=yahoo` in an un-updated environment is INERT — the wiring
    still returns the PIT provider (the `yahoo` option is gone)."""
    monkeypatch.setenv("LIVE_FUNDAMENTALS_PROVIDER", "yahoo")
    assert isinstance(build_fundamentals_provider(), PitFundamentalsAsOf)


def test_build_provider_accepts_injected_pit_for_tests():
    """An injected provider (test seam) is returned as-is — used by the cycle/host tests to stub the
    seam without HTTP."""
    sentinel = PitFundamentalsAsOf(base_url="http://x", secret="x")
    assert build_fundamentals_provider(pit_provider=sentinel) is sentinel


def test_resolve_provider_mode_is_always_pit(monkeypatch):
    """The mode resolver is PIT-only (mirrors test_fundamentals_source_endpoint, kept here so the
    wiring file's own contract is self-contained)."""
    monkeypatch.setenv("LIVE_FUNDAMENTALS_PROVIDER", "yahoo")
    assert resolve_provider_mode() == PROVIDER_MODE_PIT
