"""Tests for the LIVE strategy fundamentals-source surface (epic §F / Task 6):

  - ``resolve_provider_mode`` — the single source of truth for the live provider mode, shared by the
    startup wiring (``build_fundamentals_provider``) and the observability endpoint, so the mode the
    host runs on and the mode the portal reports can never disagree. After the Yahoo removal there is
    exactly ONE mode: `pit` (the PIT lake). The resolver always returns `pit` — it is inert to a stale
    `LIVE_FUNDAMENTALS_PROVIDER=yahoo` left in an un-updated environment.

  - ``build_fundamentals_source_response`` — the pure builder behind
    ``GET /admin/api/strategy/fundamentals-source``. Over the ``factor_scores`` store's
    ``latest_all()`` it produces ``{provider, sources:{<source>:count}, by_ticker:{ticker:{source,
    built_at}}, pit_served, last_cycle_ts}``: per-ticker ``source`` = ``factors.quality.source``,
    ``built_at`` = the row's ``observation_ts`` (the read+build instant). Cards #149 (Operations
    per-ticker table) + #150 (per-ticker source badge) consume ``by_ticker[ticker].{source,
    built_at}`` — so the ``null``-bucket / raw-``None`` contract is pinned here.

Deps-light: the fundamentals-source builder is fed a tiny in-memory fake store (no Mongo), so the
counting + the by_ticker shape are unit-testable without a live ``FactorStore`` — mirroring
``test_factor_store.py``'s fake-collection approach.
"""
from __future__ import annotations

import pytest

from src.infrastructure.fundamentals_as_of import (
    PROVIDER_MODE_PIT,
    resolve_provider_mode,
)
from src.main import build_fundamentals_source_response

_ENV = "LIVE_FUNDAMENTALS_PROVIDER"


# ── resolve_provider_mode — the shared single source of truth (now PIT-only) ──────────────────────
def test_resolve_is_always_pit(monkeypatch):
    """After the Yahoo removal the seam is PIT-only — the resolver always returns `pit`, regardless of
    arg or env (the `yahoo` option is gone)."""
    monkeypatch.delenv(_ENV, raising=False)
    assert resolve_provider_mode() == PROVIDER_MODE_PIT
    assert resolve_provider_mode("pit") == PROVIDER_MODE_PIT


def test_resolve_is_inert_to_stale_yahoo_env(monkeypatch):
    """A stale `LIVE_FUNDAMENTALS_PROVIDER=yahoo` (or any other value) left in an un-updated environment
    is INERT — it resolves to `pit`, never erroring on a config that no longer offers `yahoo`."""
    monkeypatch.setenv(_ENV, "yahoo")
    assert resolve_provider_mode() == PROVIDER_MODE_PIT
    assert resolve_provider_mode("yahoo") == PROVIDER_MODE_PIT
    monkeypatch.setenv(_ENV, "garbage")
    assert resolve_provider_mode() == PROVIDER_MODE_PIT


# ── build_fundamentals_source_response — source counts + by_ticker map over a fake store ──────────
class _FakeFactorStore:
    """Stand-in for FactorStore: ``latest_all()`` returns a canned ``{ticker: {observation_ts,
    factors}}`` map (the verbatim reader shape), so the builder's counting + by_ticker projection are
    testable without Mongo."""

    def __init__(self, latest: dict[str, dict]) -> None:
        self._latest = latest

    async def latest_all(self) -> dict[str, dict]:
        return self._latest


def _row(source, observation_ts: int) -> dict:
    """One ``latest_all`` row. Only ``factors.quality.source`` (the live provider's per-name stamp) +
    ``observation_ts`` (the read+build instant) are load-bearing here; the other factor cells are
    present for realism but never read by the builder."""
    return {
        "observation_ts": observation_ts,
        "factors": {
            "momentum":   {"raw": 0.5, "pct": 70.0, "source": "eod"},
            "volatility": {"raw": -0.2, "pct": 40.0, "source": "eod"},
            "value":      {"raw": 0.1, "pct": 55.0, "source": "div"},
            "quality":    {"raw": 0.3, "pct": 60.0, "source": source},
        },
    }


@pytest.mark.asyncio
async def test_response_counts_sources_and_builds_by_ticker():
    """A mixed universe: per-source counts, the ``pit_served`` sum, and a ``{source, built_at}`` cell
    per ticker (built_at = the row's observation_ts)."""
    store = _FakeFactorStore({
        "AAPL_US_EQ": _row("pit-edgar", 1_700_000_000_000),
        "MSFT_US_EQ": _row("pit-edgar", 1_700_000_000_000),
        "HSBAl_EQ":   _row("yahoo-snapshot", 1_700_000_000_001),
    })
    out = await build_fundamentals_source_response(
        store, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts="2026-06-08T12:00:00Z",
    )
    assert out["provider"] == PROVIDER_MODE_PIT
    assert out["sources"] == {"pit-edgar": 2, "yahoo-snapshot": 1}
    assert out["pit_served"] == 2  # only the two pit-edgar names
    assert out["last_cycle_ts"] == "2026-06-08T12:00:00Z"
    # by_ticker carries the RAW source stamp + the read+build instant per name (the #149/#150 contract).
    assert out["by_ticker"]["AAPL_US_EQ"] == {"source": "pit-edgar", "built_at": 1_700_000_000_000}
    assert out["by_ticker"]["HSBAl_EQ"] == {"source": "yahoo-snapshot", "built_at": 1_700_000_000_001}


@pytest.mark.asyncio
async def test_response_null_quality_source_buckets_as_null_keeps_raw_none():
    """A name whose quality factor had no source this cycle (the honest no-source cell) counts under
    the explicit ``"null"`` bucket in ``sources``, but ``by_ticker`` keeps the RAW ``None`` (so the
    badge can render 'none' rather than mislabelling it)."""
    store = _FakeFactorStore({
        "AAPL_US_EQ": _row("pit-edgar", 1_700_000_000_000),
        "BANK_US_EQ": _row(None, 1_700_000_000_002),  # banks lack current assets ⇒ quality null
    })
    out = await build_fundamentals_source_response(
        store, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts=None,
    )
    assert out["sources"] == {"pit-edgar": 1, "null": 1}
    assert out["pit_served"] == 1  # the "null" bucket is NOT pit-served
    assert out["by_ticker"]["BANK_US_EQ"] == {"source": None, "built_at": 1_700_000_000_002}


@pytest.mark.asyncio
async def test_response_pit_served_counts_both_pit_jurisdictions():
    """``pit_served`` sums EVERY ``pit-*`` source — both pit-edgar (US) and pit-companies-house (UK) —
    while yahoo-snapshot + null are excluded."""
    store = _FakeFactorStore({
        "AAPL_US_EQ": _row("pit-edgar", 1),
        "HSBAl_EQ":   _row("pit-companies-house", 2),
        "FOO_US_EQ":  _row("yahoo-snapshot", 3),
        "BAR_US_EQ":  _row(None, 4),
    })
    out = await build_fundamentals_source_response(store, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts=None)
    assert out["sources"] == {"pit-edgar": 1, "pit-companies-house": 1, "yahoo-snapshot": 1, "null": 1}
    assert out["pit_served"] == 2  # pit-edgar + pit-companies-house


@pytest.mark.asyncio
async def test_response_missing_observation_ts_built_at_is_none():
    """A row lacking ``observation_ts`` yields ``built_at: None`` (degrade, not a KeyError) — the
    #149/#150 contract allows a null built_at."""
    store = _FakeFactorStore({"AAPL_US_EQ": {"factors": {"quality": {"raw": 0.3, "pct": 60.0, "source": "pit-edgar"}}}})
    out = await build_fundamentals_source_response(store, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts=None)
    assert out["by_ticker"]["AAPL_US_EQ"] == {"source": "pit-edgar", "built_at": None}


@pytest.mark.asyncio
async def test_response_missing_factors_block_is_null_source():
    """A row with no ``factors`` block at all (defensive) ⇒ source ``None`` (null bucket), not a crash."""
    store = _FakeFactorStore({"AAPL_US_EQ": {"observation_ts": 1_700_000_000_000}})
    out = await build_fundamentals_source_response(store, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts=None)
    assert out["sources"] == {"null": 1}
    assert out["by_ticker"]["AAPL_US_EQ"] == {"source": None, "built_at": 1_700_000_000_000}


@pytest.mark.asyncio
async def test_response_empty_store_is_empty_maps():
    """An empty/pre-backfill store ⇒ ``sources:{}``, ``by_ticker:{}``, ``pit_served:0`` (degrade,
    never 500) — but ``provider`` + ``last_cycle_ts`` still echo through."""
    out = await build_fundamentals_source_response(
        _FakeFactorStore({}), provider_mode=PROVIDER_MODE_PIT, last_cycle_ts="2026-06-08T12:00:00Z",
    )
    assert out == {
        "provider": PROVIDER_MODE_PIT,
        "sources": {},
        "by_ticker": {},
        "pit_served": 0,
        "last_cycle_ts": "2026-06-08T12:00:00Z",
    }


@pytest.mark.asyncio
async def test_response_unwired_store_is_empty_maps():
    """A None FactorStore (engine not yet wired) ⇒ the same empty maps — the endpoint never 500s on a
    very-early boot, mirroring the scores reads' best-effort contract."""
    out = await build_fundamentals_source_response(None, provider_mode=PROVIDER_MODE_PIT, last_cycle_ts=None)
    assert out["sources"] == {}
    assert out["by_ticker"] == {}
    assert out["pit_served"] == 0
    assert out["provider"] == PROVIDER_MODE_PIT
    assert out["last_cycle_ts"] is None
