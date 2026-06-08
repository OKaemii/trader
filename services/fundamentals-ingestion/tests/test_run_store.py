"""Force-ingest run store tests — the single-flight background runner (Ops backend card).

Proves the real force-ingest contract WITHOUT a network/DB/EDGAR: a trigger STARTS a run and returns a
run_id immediately; the background task folds the orchestrator summary into the run record (done +
counts); a SECOND trigger while one is in flight is single-flighted (no second orchestrator); an
orchestrator failure records a `failed` run and RELEASES the gate; an empty effective UA refuses to
start (fail-closed, mirroring `python -m src.ingest` exit-2). The orchestrator factory + coverage
resolver + config provider are injected fakes.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass

import pytest

from src.config import FundamentalsConfig
from src.run_store import STATE_DONE, STATE_FAILED, STATE_RUNNING, IngestRunStore


# ── injectable fakes ───────────────────────────────────────────────────────────────
@dataclass
class _Summary:
    """The IngestSummary subset the run store reads off the orchestrator result."""

    requested: int = 0
    ingested: int = 0
    skipped: int = 0
    raw_written: int = 0
    canonical_inserted: int = 0
    canonical_revisions: int = 0
    canonical_skipped: int = 0
    quarantined: int = 0


class _FakeOrchestrator:
    """Records the symbols it was run with and returns a fixed summary; an optional `gate` event lets a
    test hold the run 'in flight' to exercise single-flight, and `boom` makes `run` raise."""

    def __init__(self, summary: _Summary, *, gate: asyncio.Event | None = None, boom: bool = False) -> None:
        self._summary = summary
        self._gate = gate
        self._boom = boom
        self.ran_with: list[str] | None = None

    async def run(self, symbols):
        self.ran_with = list(symbols)
        if self._gate is not None:
            await self._gate.wait()  # block until the test releases it (run stays 'running')
        if self._boom:
            raise RuntimeError("orchestrator exploded")
        s = self._summary
        s.requested = len(symbols)
        s.ingested = len(symbols)
        return s


def _config(ua: str = "trader-platform/1.0 (ops@example.com)", *, source: str = "override"):
    """A minimal config provider stand-in exposing the single `get()` the run store calls."""

    cfg = FundamentalsConfig(
        edgar_user_agent=ua, coverage_cap=None, ingest_enabled=True, edgar_user_agent_source=source
    )

    class _P:
        async def get(self, *, force_refresh: bool = False):  # noqa: ARG002
            return cfg

    return _P()


def _store(orchestrator: _FakeOrchestrator, *, symbols=("AAPL", "MSFT"), config=None) -> IngestRunStore:
    async def _factory(_ua):
        return orchestrator

    async def _coverage(tickers, _cap):
        return list(tickers) if tickers else list(symbols)

    return IngestRunStore(
        orchestrator_factory=_factory,
        coverage_resolver=_coverage,
        config_provider=config if config is not None else _config(),
    )


# ── tests ───────────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_start_returns_run_id_immediately_and_completes() -> None:
    orch = _FakeOrchestrator(_Summary(canonical_inserted=24, quarantined=2))
    store = _store(orch)

    record, started = await store.start()
    assert started is True
    assert record.run_id and record.state == STATE_RUNNING  # returned BEFORE the run finished
    assert record.scope == "all"

    # Let the background task run to completion, then assert the record was folded with the summary.
    for _ in range(50):
        await asyncio.sleep(0)
        if store.get(record.run_id).state != STATE_RUNNING:
            break
    done = store.get(record.run_id)
    assert done.state == STATE_DONE
    assert done.requested == 2 and done.ingested == 2
    assert done.canonical_inserted == 24 and done.quarantined == 2
    assert done.finished_at_ms is not None
    assert orch.ran_with == ["AAPL", "MSFT"]
    assert store.is_running() is False  # gate released after completion


@pytest.mark.asyncio
async def test_second_trigger_is_single_flighted_while_running() -> None:
    gate = asyncio.Event()
    orch = _FakeOrchestrator(_Summary(), gate=gate)
    store = _store(orch)

    first, started1 = await store.start()
    await asyncio.sleep(0)  # let the task start and acquire the running flag
    assert started1 is True and store.is_running() is True

    # Second trigger while the first is blocked on the gate → rejected, returns the SAME in-flight run.
    second, started2 = await store.start()
    assert started2 is False
    assert second.run_id == first.run_id

    gate.set()  # release the first run
    for _ in range(50):
        await asyncio.sleep(0)
        if not store.is_running():
            break
    assert store.is_running() is False

    # A trigger AFTER completion starts a fresh run (new id).
    third, started3 = await store.start()
    assert started3 is True and third.run_id != first.run_id


@pytest.mark.asyncio
async def test_failed_orchestrator_records_failed_and_releases_gate() -> None:
    orch = _FakeOrchestrator(_Summary(), boom=True)
    store = _store(orch)
    record, started = await store.start()
    assert started is True
    for _ in range(50):
        await asyncio.sleep(0)
        if store.get(record.run_id).state != STATE_RUNNING:
            break
    failed = store.get(record.run_id)
    assert failed.state == STATE_FAILED
    assert failed.reason == "error:RuntimeError"
    assert store.is_running() is False  # the finally released the gate even on failure


@pytest.mark.asyncio
async def test_empty_user_agent_refuses_to_start() -> None:
    orch = _FakeOrchestrator(_Summary())
    store = _store(orch, config=_config(ua="", source="default"))
    record, started = await store.start()
    assert started is False
    assert record.state == STATE_FAILED
    assert record.reason == "empty_user_agent"
    assert orch.ran_with is None  # the orchestrator was never built/run
    assert store.is_running() is False


@pytest.mark.asyncio
async def test_subset_scope_passes_explicit_tickers() -> None:
    orch = _FakeOrchestrator(_Summary())
    store = _store(orch)
    record, started = await store.start(tickers=["AAPL"])
    assert started is True and record.scope == "subset"
    for _ in range(50):
        await asyncio.sleep(0)
        if store.get(record.run_id).state != STATE_RUNNING:
            break
    assert orch.ran_with == ["AAPL"]


@pytest.mark.asyncio
async def test_no_coverage_symbols_marks_done_with_reason() -> None:
    orch = _FakeOrchestrator(_Summary())
    store = _store(orch, symbols=())  # empty coverage
    record, started = await store.start()
    assert started is True
    for _ in range(50):
        await asyncio.sleep(0)
        if store.get(record.run_id).state != STATE_RUNNING:
            break
    done = store.get(record.run_id)
    assert done.state == STATE_DONE
    assert done.reason == "no_coverage_symbols"
    assert orch.ran_with is None  # orchestrator not run when there are no symbols


@pytest.mark.asyncio
async def test_latest_returns_most_recent_run() -> None:
    orch = _FakeOrchestrator(_Summary())
    store = _store(orch)
    r1, _ = await store.start()
    for _ in range(50):
        await asyncio.sleep(0)
        if not store.is_running():
            break
    r2, _ = await store.start()
    assert store.latest().run_id == r2.run_id != r1.run_id
