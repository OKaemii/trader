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
    _seed_filing,
    _seed_instrument,
)

_DAY = 86_400_000


def _args(**overrides) -> argparse.Namespace:
    """A Namespace with the ingest CLI defaults, overridable per test (mirrors `_parse_args`'s output
    so a test drives `run_async`/`_filter_stale_symbols` without building an argv)."""
    base = dict(tickers="", full=False, cap=None, window_years=30, heal=False, stale_after_days=None,
                annual_stale_after_days=None)
    base.update(overrides)
    return argparse.Namespace(**base)


# ── argument parsing ──────────────────────────────────────────────────────────────────────────────
def test_heal_flag_defaults_off() -> None:
    args = ingest._parse_args([])
    assert args.heal is False                 # absent ⇒ the full walk (unchanged default)
    assert args.stale_after_days is None      # absent ⇒ env / built-in default window


def test_heal_flag_and_stale_after_days_parse() -> None:
    args = ingest._parse_args(["--heal", "--stale-after-days", "90", "--annual-stale-after-days", "420"])
    assert args.heal is True
    assert args.stale_after_days == 90
    assert args.annual_stale_after_days == 420


def test_annual_stale_after_days_defaults_off() -> None:
    args = ingest._parse_args([])
    assert args.annual_stale_after_days is None    # absent ⇒ env / built-in 400-day annual default


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


def test_annual_stale_after_days_precedence(monkeypatch) -> None:
    # Flag wins over env (mirrors the quarterly knob's precedence).
    monkeypatch.setenv("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", "500")
    assert ingest._annual_stale_after_days(_args(annual_stale_after_days=420)) == 420
    # No flag ⇒ env.
    assert ingest._annual_stale_after_days(_args()) == 500
    # No flag, no env ⇒ None (the audit then applies its 400-day annual default).
    monkeypatch.delenv("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", raising=False)
    assert ingest._annual_stale_after_days(_args()) is None
    # A non-int env is ignored (falls back to None ⇒ default annual window — never "never stale").
    monkeypatch.setenv("FUNDAMENTALS_STALE_AFTER_DAYS_ANNUAL", "not-a-number")
    assert ingest._annual_stale_after_days(_args()) is None


@pytest.mark.asyncio
async def test_heal_annual_filer_not_force_re_ingested(monkeypatch) -> None:
    """`--heal` must NOT keep re-ingesting a 20-F annual filer every cycle: with a recent annual filing
    and a fiscal period inside the 400-day annual window, the name is fresh → not in the heal subset,
    while a 10-Q filer at the same age is stale → healed. End-to-end through the REAL freshness_audit."""
    mongo = _FakeMongo(["AAPL_US_EQ", "TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 900_000 * _DAY
    age = 200 * _DAY
    monkeypatch.setattr(ingest.time, "time", lambda: now / 1000)  # freeze now_ms = now
    # AAPL: a 10-Q filer, fiscal period 200 days old → stale under the 135-day window → healed.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - age + _DAY)
    # TSM: a 20-F annual filer, same 200-day-old period → fresh under the 400-day annual window → skipped.
    _seed_instrument(db, instrument_id=2, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=2, form_type="20-F", accepted_ts=now - age + _DAY)
    _patch_freshness_sources(monkeypatch, timescale=db, mongo=mongo)

    subset = await ingest._filter_stale_symbols(["AAPL", "TSM"], _args(heal=True))
    assert subset == ["AAPL"]      # only the quarterly filer; the 20-F is not re-healed every cycle


@pytest.mark.asyncio
async def test_heal_annual_filer_with_newer_current_reports_not_re_ingested(monkeypatch) -> None:
    """The REALISTIC --heal shape. A 20-F filer's newest filing is NOT its annual report — newer 6-K/8-K/
    Form-4 current reports post-date the 20-F. Keying staleness on "newest filing is the annual form"
    misclassified the name quarterly → it was force-re-ingested every heal cycle (the bug). With cadence-
    based classification it is annual and fresh at 200 days → NOT in the heal subset; a 10-Q filer at the
    same age still is. End-to-end through the REAL freshness_audit."""
    mongo = _FakeMongo(["AAPL_US_EQ", "TSM_US_EQ"])
    db = _FreshnessFakeTimescale()
    now = 900_000 * _DAY
    age = 200 * _DAY
    monkeypatch.setattr(ingest.time, "time", lambda: now / 1000)  # freeze now_ms = now
    # AAPL: a 10-Q filer at 200 days → stale under the 135-day window → healed.
    _seed_instrument(db, instrument_id=1, t212_ticker="AAPL_US_EQ")
    _seed_fact(db, instrument_id=1, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=1, form_type="10-Q", accepted_ts=now - age + _DAY)
    # TSM: a 20-F annual filer whose 20-F is the OLDEST filing; newer 6-K/8-K/Form-4 post-date it (newest
    # filing overall is the Form-4). No 10-Q. Same 200-day-old period → fresh under the 400-day annual
    # window → must be SKIPPED by heal, not re-ingested every cycle.
    _seed_instrument(db, instrument_id=2, t212_ticker="TSM_US_EQ")
    _seed_fact(db, instrument_id=2, metric="net_income", observation_ts=now - age, knowledge_ts=now - age + _DAY)
    _seed_filing(db, instrument_id=2, form_type="20-F", accepted_ts=now - age)
    _seed_filing(db, instrument_id=2, form_type="6-K", accepted_ts=now - 90 * _DAY)
    _seed_filing(db, instrument_id=2, form_type="8-K", accepted_ts=now - 40 * _DAY)
    _seed_filing(db, instrument_id=2, form_type="4", accepted_ts=now - 10 * _DAY)
    _patch_freshness_sources(monkeypatch, timescale=db, mongo=mongo)

    subset = await ingest._filter_stale_symbols(["AAPL", "TSM"], _args(heal=True))
    assert subset == ["AAPL"]      # the 20-F filer is NOT re-healed despite newer non-annual filings


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
