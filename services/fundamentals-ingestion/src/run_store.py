"""Force-ingest run store — the single-flight background runner behind the real force-ingest endpoint.

This is what turns the T3 accept-only stub into a REAL trigger: it runs the Task-9 orchestrator over
the coverage set IN-CLUSTER, but as a BACKGROUND asyncio task — a full backfill walks every coverage
filer's decades of filings (minutes→hours), so the HTTP handler MUST NOT block on it. The endpoint
starts the run, gets back a `run_id` immediately, and the caller polls the status endpoint for progress.

THE CONTRACT the endpoint needs:
  * `start(...)` → kicks off the orchestrator in `asyncio.create_task`, records a `RunRecord`
    (run_id, started_at, state=running, scope, counts=0), and returns it immediately.
  * SINGLE-FLIGHT — a backfill is heavy; a second trigger while one is RUNNING is rejected (returns the
    in-flight record + `started=False`), never a second concurrent orchestrator. The guard is an
    in-process flag (the Deployment is `replicas: 1`, so process-local single-flight is the right scope;
    a multi-replica future would move this to a Redis lock — noted, not built).
  * `latest()` / `get(run_id)` → the status endpoint reads the last run's state + counts + timing.

STATE MACHINE:  running → done   (the orchestrator returned a summary)
                running → failed (the orchestrator raised, OR the effective UA was empty — fail-closed)
A `done`/`failed` run is terminal and stays readable as "the last run" until the next `start`.

EFFECTIVE-UA FAIL-CLOSED: the runner resolves the effective UA from the config provider (override > env
> default) and REFUSES to start — recording a `failed` run with `reason='empty_user_agent'` — when it
is empty, mirroring `python -m src.ingest`'s exit-2 refusal. SEC blocks an anonymous request; we never
send one. (In practice the non-empty built-in default means a run starts; the guard is the contract.)

DEPENDENCY INVERSION: the orchestrator FACTORY + the coverage RESOLVER + the config provider are
injected, so the unit gate drives the whole thing with fakes (no network, no DB, no real EDGAR). The
composition root (`main.py`) supplies the real ones built from env. The runner never imports asyncpg/
motor/httpx itself — it only orchestrates the injected coroutines.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Optional

from src.config import FundamentalsConfig, FundamentalsConfigProvider, effective_user_agent

log = logging.getLogger("fundamentals-ingestion.run_store")

# Run states (the status endpoint surfaces these verbatim).
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"

# A factory that builds the orchestrator for a given effective UA (the composition root injects the real
# one; tests inject a fake). Returns an object exposing `async run(symbols) -> IngestSummary`.
OrchestratorFactory = Callable[[str], Awaitable[object]]
# Resolves the coverage symbols for a run: an explicit subset (the endpoint's `tickers`) OR the full
# configured set when None. Returns the bare US symbols the orchestrator ingests.
CoverageResolver = Callable[[Optional[list[str]], Optional[int]], Awaitable[list[str]]]


@dataclass
class RunRecord:
    """One force-ingest run's bookkeeping — the status endpoint's `last_run`. Mutated in place by the
    background task as the run progresses (counts filled on completion)."""

    run_id: str
    state: str
    scope: str                      # 'subset' | 'all'
    started_at_ms: int
    finished_at_ms: Optional[int] = None
    requested: int = 0              # symbols the run was asked to ingest
    ingested: int = 0
    skipped: int = 0
    raw_written: int = 0
    canonical_inserted: int = 0
    canonical_revisions: int = 0
    canonical_skipped: int = 0
    quarantined: int = 0
    reason: Optional[str] = None    # set on a failed run (why), or 'empty_user_agent'
    user_agent_source: Optional[str] = None  # which layer the effective UA came from (provenance)

    def to_payload(self) -> dict:
        """The JSON the status/force endpoints return (snake_case, ms timestamps)."""
        return {
            "run_id": self.run_id,
            "state": self.state,
            "scope": self.scope,
            "started_at_ms": self.started_at_ms,
            "finished_at_ms": self.finished_at_ms,
            "requested": self.requested,
            "ingested": self.ingested,
            "skipped": self.skipped,
            "raw_written": self.raw_written,
            "canonical_inserted": self.canonical_inserted,
            "canonical_revisions": self.canonical_revisions,
            "canonical_skipped": self.canonical_skipped,
            "quarantined": self.quarantined,
            "reason": self.reason,
            "user_agent_source": self.user_agent_source,
        }


def _now_ms() -> int:
    return int(time.time() * 1000)


class IngestRunStore:
    """In-process registry of force-ingest runs with single-flight. One instance per process (built in
    `main.py`); the FastAPI handlers call `start`/`latest`/`get`."""

    def __init__(
        self,
        *,
        orchestrator_factory: OrchestratorFactory,
        coverage_resolver: CoverageResolver,
        config_provider: FundamentalsConfigProvider,
    ) -> None:
        self._make_orchestrator = orchestrator_factory
        self._resolve_coverage = coverage_resolver
        self._config = config_provider
        self._runs: dict[str, RunRecord] = {}
        self._latest_id: Optional[str] = None
        self._running_id: Optional[str] = None
        # Guards the check-then-set of the single-flight flag against two concurrent triggers racing
        # between the "is one running?" read and the task creation.
        self._lock = asyncio.Lock()

    def is_running(self) -> bool:
        return self._running_id is not None

    def latest(self) -> Optional[RunRecord]:
        return self._runs.get(self._latest_id) if self._latest_id else None

    def get(self, run_id: str) -> Optional[RunRecord]:
        return self._runs.get(run_id)

    async def start(
        self, *, tickers: Optional[list[str]] = None, cap: Optional[int] = None
    ) -> tuple[RunRecord, bool]:
        """Start a force-ingest run (single-flight). Returns `(record, started)`:
          * `started=True`  — a NEW run was kicked off in the background; `record` is its fresh
            `running` record (or a terminal `failed` record if the effective UA was empty — that refusal
            is synchronous, no task spawned).
          * `started=False` — a run is ALREADY in flight; `record` is the in-flight run (the caller
            should treat this as a no-op accept, not an error — the heavy backfill is not duplicated).

        `tickers` (bare US symbols, or None for the full coverage set) scopes the run; `cap` overrides
        the coverage cap for this run (None ⇒ the config/env cap)."""
        async with self._lock:
            if self._running_id is not None:
                in_flight = self._runs[self._running_id]
                log.info("[run_store] force-ingest rejected — run %s already in flight", in_flight.run_id)
                return in_flight, False

            cfg = await self._config.get()
            ua = effective_user_agent(cfg)
            scope = "subset" if tickers else "all"
            run_id = uuid.uuid4().hex

            if ua is None:
                # Fail closed — record a terminal failed run, spawn nothing (SEC must never see an
                # anonymous request). Mirrors `python -m src.ingest` exit-2.
                record = RunRecord(
                    run_id=run_id, state=STATE_FAILED, scope=scope, started_at_ms=_now_ms(),
                    finished_at_ms=_now_ms(), reason="empty_user_agent",
                    user_agent_source=cfg.edgar_user_agent_source,
                )
                self._runs[run_id] = record
                self._latest_id = run_id
                log.error("[run_store] force-ingest refused — effective EDGAR User-Agent is empty")
                return record, False

            record = RunRecord(
                run_id=run_id, state=STATE_RUNNING, scope=scope, started_at_ms=_now_ms(),
                user_agent_source=cfg.edgar_user_agent_source,
            )
            self._runs[run_id] = record
            self._latest_id = run_id
            self._running_id = run_id
            # Spawn the orchestrator OFF the request path. The task owns clearing _running_id (in its
            # finally) so a crashed run still releases the single-flight gate.
            asyncio.create_task(self._run(record, ua=ua, tickers=tickers, cap=cap))
            log.info("[run_store] force-ingest started run %s (scope=%s)", run_id, scope)
            return record, True

    async def _run(
        self, record: RunRecord, *, ua: str, tickers: Optional[list[str]], cap: Optional[int]
    ) -> None:
        """The background body: resolve coverage → run the orchestrator → fold the summary into the
        record. Any failure marks the run `failed` with the exception class as the reason. Always clears
        the single-flight gate so a later trigger can start."""
        try:
            symbols = await self._resolve_coverage(tickers, cap)
            record.requested = len(symbols)
            if not symbols:
                record.state = STATE_DONE
                record.reason = "no_coverage_symbols"
                log.warning("[run_store] run %s resolved no coverage symbols — nothing to do", record.run_id)
                return
            orchestrator = await self._make_orchestrator(ua)
            summary = await orchestrator.run(symbols)
            record.requested = summary.requested
            record.ingested = summary.ingested
            record.skipped = summary.skipped
            record.raw_written = summary.raw_written
            record.canonical_inserted = summary.canonical_inserted
            record.canonical_revisions = summary.canonical_revisions
            record.canonical_skipped = summary.canonical_skipped
            record.quarantined = summary.quarantined
            record.state = STATE_DONE
            log.info(
                "[run_store] run %s DONE requested=%d ingested=%d canonical_inserted=%d quarantined=%d",
                record.run_id, record.requested, record.ingested, record.canonical_inserted,
                record.quarantined,
            )
        except Exception as exc:  # noqa: BLE001 — a failed background run is recorded, not raised
            record.state = STATE_FAILED
            record.reason = f"error:{type(exc).__name__}"
            log.exception("[run_store] run %s FAILED: %s", record.run_id, exc)
        finally:
            record.finished_at_ms = _now_ms()
            self._running_id = None
