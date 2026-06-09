"""Self-heal ingest tests (epic coverage-broaden Task 5).

Proves the `--heal` mode of `python -m src.ingest`:
  * `_filter_stale_symbols` narrows a resolved coverage set to ONLY the missing/stale curated-US names,
    REUSING `freshness.freshness_audit` (the same per-name coverage+staleness query the `…/freshness`
    endpoint serves) — exercised end-to-end against the real audit over the Task-4 fakes, so the reuse
    is genuine, not stubbed;
  * `run_async` routes a `--heal` run through that filter, so the orchestrator ingests only the stale
    subset, while WITHOUT `--heal` the full resolved coverage set reaches the orchestrator UNCHANGED
    (the nightly full walk is byte-for-byte as before);
  * `--heal` / `--stale-after-days` parse, and the staleness window precedence (flag > env > default).

No network, no real DB: the audit runs over `test_freshness`'s `_FakeMongo` (curated-universe read) +
`_FreshnessFakeTimescale` (the canonical-fact aggregates); `run_async`'s EDGAR/orchestrator/pool seams
are replaced with light fakes so only the heal WIRING is under test (the freshness query itself is
covered exhaustively in `test_freshness.py`).
"""
from __future__ import annotations

import argparse

import pytest

from src import ingest
# Reuse the Task-4 freshness fakes so _filter_stale_symbols runs the REAL freshness_audit end-to-end.
from tests.test_freshness import (
    _FakeMongo,
    _FreshnessFakeTimescale,
    _seed_fact,
    _seed_instrument,
)

_DAY = 86_400_000


def _args(**overrides) -> argparse.Namespace:
    """A Namespace with the ingest CLI defaults, overridable per test (mirrors `_parse_args`'s output
    so a test drives `run_async`/`_filter_stale_symbols` without building an argv)."""
    base = dict(tickers="", full=False, cap=None, window_years=30, heal=False, stale_after_days=None)
    base.update(overrides)
    return argparse.Namespace(**base)


# ── argument parsing ──────────────────────────────────────────────────────────────────────────────
def test_heal_flag_defaults_off() -> None:
    args = ingest._parse_args([])
    assert args.heal is False                 # absent ⇒ the full walk (unchanged default)
    assert args.stale_after_days is None      # absent ⇒ env / built-in default window


def test_heal_flag_and_stale_after_days_parse() -> None:
    args = ingest._parse_args(["--heal", "--stale-after-days", "90"])
    assert args.heal is True
    assert args.stale_after_days == 90


def test_stale_after_days_precedence(monkeypatch) -> None:
    # Flag wins over env.
    monkeypatch.setenv("FUNDAMENTALS_STALE_AFTER_DAYS", "200")
    assert ingest._stale_after_days(_args(stale_after_days=90)) == 90
    # No flag ⇒ env.
    assert ingest._stale_after_days(_args()) == 200
    # No flag, no env ⇒ None (the audit then applies its 135-day default).
    monkeypatch.delenv("FUNDAMENTALS_STALE_AFTER_DAYS", raising=False)
    assert ingest._stale_after_days(_args()) is None
    # A non-int env is ignored (falls back to None ⇒ default window — never silently "never stale").
    monkeypatch.setenv("FUNDAMENTALS_STALE_AFTER_DAYS", "not-a-number")
    assert ingest._stale_after_days(_args()) is None


# ── _filter_stale_symbols (end-to-end against the real freshness_audit) ─────────────────────────────
def _patch_freshness_sources(monkeypatch, *, timescale, mongo) -> None:
    """Point `_filter_stale_symbols`'s two lazily-imported seams at in-memory fakes: the singleton
    asyncpg pool (`get_pool`) and the motor client. Both are imported INSIDE the function, so patch the
    source modules `src.security_master.pool.get_pool` and `motor.motor_asyncio.AsyncIOMotorClient`."""
    async def _fake_get_pool(*_a, **_k):
        return timescale

    class _FakeMotorClient:
        def __init__(self, *_a, **_k) -> None:
            pass

        def __getitem__(self, _name):
            return mongo

        def close(self) -> None:
            pass

    monkeypatch.setattr("src.security_master.pool.get_pool", _fake_get_pool)
    monkeypatch.setattr("motor.motor_asyncio.AsyncIOMotorClient", _FakeMotorClient)


@pytest.mark.asyncio
async def test_filter_stale_selects_only_missing_and_stale(monkeypatch) -> None:
    # Curated US universe = AAPL (fresh), MSFT (stale period), NVDA (missing). VOD (UK) is dropped by
    # the US filter in the coverage read, so it never reaches the freshness audit.
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ", "NVDA_US_EQ", "VODl_EQ"])
    db = _FreshnessFakeTimescale()
    now = 900_000 * _DAY
    monkeypatch.setattr(ingest.time, "time", lambda: now / 1000)  # freeze now_ms = now
    # AAPL: covered + FRESH fiscal period (period_end == now) → not stale → NOT healed.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now, knowledge_ts=now + _DAY)
    # MSFT: covered but STALE (period_end 200 days ago > the 135-day default window) → healed.
    _seed_instrument(db, instrument_id=2, t212_ticker="MSFT_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - 200 * _DAY,
               knowledge_ts=now - 199 * _DAY)
    # NVDA: no instrument, no fact → missing (uncovered ⇒ stale) → healed.
    _patch_freshness_sources(monkeypatch, timescale=db, mongo=mongo)

    # The resolved coverage set the run would ingest (the bare US symbols, sorted).
    resolved = ["AAPL", "MSFT", "NVDA"]
    subset = await ingest._filter_stale_symbols(resolved, _args(heal=True))

    assert subset == ["MSFT", "NVDA"]          # only the stale + missing names; AAPL (fresh) skipped


@pytest.mark.asyncio
async def test_filter_stale_intersects_with_resolved_set(monkeypatch) -> None:
    """The stale subset is the INTERSECTION of the resolved coverage set and the audit's stale names:
    a stale curated name that is NOT in the resolved set this run (e.g. excluded by `--tickers`) is not
    healed, and an index-only remainder symbol outside the curated freshness universe is never added."""
    mongo = _FakeMongo(["AAPL_US_EQ", "MSFT_US_EQ"])
    db = _FreshnessFakeTimescale()       # cold warehouse → BOTH AAPL & MSFT are missing ⇒ stale.
    now = 100 * _DAY
    monkeypatch.setattr(ingest.time, "time", lambda: now / 1000)
    _patch_freshness_sources(monkeypatch, timescale=db, mongo=mongo)

    # Resolved set is only AAPL (+ an index-only remainder XYZ outside the curated universe). MSFT is
    # stale per the audit but absent from the resolved set, so it must NOT appear; XYZ is outside the
    # freshness universe, so it must NOT appear either.
    subset = await ingest._filter_stale_symbols(["AAPL", "XYZ"], _args(heal=True))
    assert subset == ["AAPL"]


@pytest.mark.asyncio
async def test_filter_stale_honours_window_override(monkeypatch) -> None:
    # A covered name whose period_end is 120 days old: stale under a 90-day window, fresh under 135.
    mongo = _FakeMongo(["AAPL_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 700_000 * _DAY
    monkeypatch.setattr(ingest.time, "time", lambda: now / 1000)
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - 120 * _DAY,
               knowledge_ts=now - 119 * _DAY)
    _patch_freshness_sources(monkeypatch, timescale=db, mongo=mongo)

    # 90-day window → 120-day-old period is stale → healed.
    assert await ingest._filter_stale_symbols(["AAPL"], _args(heal=True, stale_after_days=90)) == ["AAPL"]
    # Default (135-day) window → 120-day-old period is still fresh → nothing to heal.
    assert await ingest._filter_stale_symbols(["AAPL"], _args(heal=True)) == []


# ── run_async wiring: --heal filters; the full walk is unchanged ────────────────────────────────────
class _RecordingOrchestrator:
    """Captures the symbol list handed to `run()` so a test can assert exactly what got ingested."""

    def __init__(self) -> None:
        self.ran_with: list[str] | None = None

    async def run(self, symbols):
        self.ran_with = list(symbols)
        # The summary shape run_async logs (attribute access only — values are immaterial to the test).
        return argparse.Namespace(
            requested=len(symbols), ingested=len(symbols), skipped=0, raw_written=0,
            canonical_inserted=0, canonical_revisions=0, canonical_skipped=0, quarantined=0,
        )


def _patch_run_async_seams(monkeypatch, *, orchestrator, resolved, stale_subset) -> None:
    """Replace run_async's heavy seams: a non-empty UA (so it doesn't exit 2), the orchestrator build,
    the coverage resolver (returns `resolved`), the close_pool teardown, and `_filter_stale_symbols`
    (returns `stale_subset`) — so the test asserts the HEAL-vs-full ROUTING in run_async, independent of
    the freshness query (covered separately above)."""
    async def _ua():
        return "trader-platform test ops@example.com"

    async def _build(_ua_arg):
        return orchestrator

    async def _resolve(_args):
        return list(resolved)

    async def _filter(_symbols, _args):
        return list(stale_subset)

    async def _close():
        return None

    monkeypatch.setattr(ingest, "_effective_user_agent", _ua)
    monkeypatch.setattr(ingest, "_build_orchestrator", _build)
    monkeypatch.setattr(ingest, "_resolve_symbols", _resolve)
    monkeypatch.setattr(ingest, "_filter_stale_symbols", _filter)
    monkeypatch.setattr("src.security_master.pool.close_pool", _close)


@pytest.mark.asyncio
async def test_run_async_full_walk_ingests_entire_resolved_set(monkeypatch) -> None:
    """Without --heal, run_async ingests the FULL resolved coverage set — _filter_stale_symbols is
    never consulted (the nightly full walk is unchanged)."""
    orch = _RecordingOrchestrator()
    filter_calls = {"n": 0}

    async def _tracking_filter(_symbols, _args):
        filter_calls["n"] += 1
        return ["MSFT"]

    _patch_run_async_seams(monkeypatch, orchestrator=orch, resolved=["AAPL", "MSFT", "NVDA"],
                           stale_subset=["MSFT"])
    monkeypatch.setattr(ingest, "_filter_stale_symbols", _tracking_filter)

    rc = await ingest.run_async(_args(heal=False))
    assert rc == 0
    assert orch.ran_with == ["AAPL", "MSFT", "NVDA"]   # entire resolved set ingested
    assert filter_calls["n"] == 0                       # heal filter NOT invoked on the full walk


@pytest.mark.asyncio
async def test_run_async_heal_ingests_only_stale_subset(monkeypatch) -> None:
    """With --heal, run_async ingests ONLY the missing/stale subset _filter_stale_symbols returns."""
    orch = _RecordingOrchestrator()
    _patch_run_async_seams(monkeypatch, orchestrator=orch, resolved=["AAPL", "MSFT", "NVDA"],
                           stale_subset=["MSFT", "NVDA"])

    rc = await ingest.run_async(_args(heal=True))
    assert rc == 0
    assert orch.ran_with == ["MSFT", "NVDA"]            # only the stale subset, not the full set


@pytest.mark.asyncio
async def test_run_async_heal_no_op_when_all_fresh(monkeypatch) -> None:
    """With --heal and nothing stale, run_async returns 0 WITHOUT calling the orchestrator (no EDGAR
    traffic, no empty run)."""
    orch = _RecordingOrchestrator()
    _patch_run_async_seams(monkeypatch, orchestrator=orch, resolved=["AAPL", "MSFT"], stale_subset=[])

    rc = await ingest.run_async(_args(heal=True))
    assert rc == 0
    assert orch.ran_with is None                        # orchestrator.run never called — nothing to heal
