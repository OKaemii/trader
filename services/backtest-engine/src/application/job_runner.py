"""JobRunner — durable async queue for the long-running validation/backtest jobs.

Both job kinds (MCPT validation, walk-forward backtest) are far too long for an HTTP handler, so
the endpoints only enqueue a `validation_jobs` document (with a `kind`) and return `{job_id}`. This
background task — started in the FastAPI lifespan — claims one queued job at a time (FIFO, atomic),
dispatches on `kind` to an injected `JobHandler` (`load` on the event loop → `run` off it via a
worker thread → `summarize` back on the loop), and writes the report back.

It owns nothing kind-specific: handlers are injected from `main.py`. While a job runs, a sibling
`_flush` task persists the in-memory `ThreadSafeProgress` snapshot to the doc every few seconds and
relays an operator `cancelRequested` back into the sink (cooperative cancellation). The compute
thread never touches Mongo — the flusher does, on the loop.

Single-instance by deployment (`replicas: 1`): the startup sweep reverts any job a prior process
left `running` (a crash/rolling-restart victim) back to `queued`. The atomic `find_one_and_update`
claim remains correct if that ever changes.
"""
from __future__ import annotations

import asyncio
import contextlib
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable

from pymongo import ReturnDocument

from .progress import JobCancelled, ThreadSafeProgress

POLL_INTERVAL_S = 30
FLUSH_INTERVAL_S = 3
JOB_TIMEOUT_S = 24 * 60 * 60     # hard cap; a run past this is marked failed


@dataclass
class JobHandler:
    """Per-kind strategy: load history (event loop) → run compute (worker thread, takes a progress
    sink) → summarize (event loop, e.g. write the historical backtest_results row)."""
    load: Callable[[dict], Awaitable[dict]]              # (request) -> ctx
    run: Callable[[dict, dict, object], Awaitable[dict]]  # (ctx, request, progress) -> report dict
    summarize: Callable[[object, dict], Awaitable[None]]  # (db, report) -> None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _compact_summary(report: dict) -> dict:
    """A small top-level summary for the jobs *list* (which projects out the big `report`): the
    pass/fail flag + early-stop counts, kind-agnostic."""
    s = {'passed': bool(report.get('passed', False)), 'early_stopped': False}
    step2 = report.get('step2_in_sample_mcpt') or {}
    step4 = report.get('step4_walk_forward_mcpt') or {}
    if step2.get('early_stopped') or step4.get('early_stopped'):
        st = step2 if step2.get('early_stopped') else step4
        s.update(early_stopped=True, n_done=st.get('n_permutations'), n_planned=st.get('n_planned'))
    return s


class JobRunner:
    def __init__(self, db, handlers: dict[str, JobHandler]) -> None:
        self._db = db
        self._handlers = handlers
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    async def sweep_stuck(self) -> int:
        """Boot recovery: re-queue jobs a prior process left mid-run (replicas: 1 ⇒ any `running`
        row on startup is stale)."""
        res = await self._db['validation_jobs'].update_many(
            {'status': 'running'},
            {'$set': {'status': 'queued', 'sweptAt': _now()}, '$unset': {'cancelRequested': ''}},
        )
        return res.modified_count

    async def _loop(self) -> None:
        while True:
            try:
                job = await self._claim_next()
                if job is None:
                    await asyncio.sleep(POLL_INTERVAL_S)
                    continue
                await self._run_one(job)
            except asyncio.CancelledError:
                return
            except Exception:
                # _run_one records its own failures; this guards the claim/poll path itself.
                traceback.print_exc()
                await asyncio.sleep(POLL_INTERVAL_S)

    async def _claim_next(self):
        return await self._db['validation_jobs'].find_one_and_update(
            {'status': 'queued'},
            {'$set': {'status': 'running', 'claimedAt': _now()}},
            sort=[('createdAt', 1)],
            return_document=ReturnDocument.AFTER,
        )

    async def _run_one(self, job) -> None:
        handler = self._handlers.get(job.get('kind', 'mcpt'))
        if handler is None:
            await self._terminal(job, 'failed', error=f"unknown job kind {job.get('kind')!r}")
            return

        sink = ThreadSafeProgress()
        flusher = asyncio.create_task(self._flush(job['_id'], sink))
        try:
            ctx = await handler.load(dict(job['request']))                 # network + Mongo, event loop
            report = await asyncio.wait_for(
                asyncio.to_thread(lambda: asyncio.run(handler.run(ctx, dict(job['request']), sink))),
                timeout=JOB_TIMEOUT_S)
            await self._terminal(job, 'completed', report=report, progress=sink.snapshot())
            try:
                await handler.summarize(self._db, report)
            except Exception:
                traceback.print_exc()                                       # summary is best-effort
        except JobCancelled:
            await self._terminal(job, 'cancelled', progress=sink.snapshot())
        except Exception as e:   # noqa: BLE001 — record every failure on the job, never crash the loop
            await self._terminal(job, 'failed', error=str(e),
                                 tb=traceback.format_exc(), progress=sink.snapshot())
        finally:
            flusher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await flusher

    async def _flush(self, job_id, sink: ThreadSafeProgress) -> None:
        """Every few seconds: relay an operator cancel into the sink and persist the progress
        snapshot. Runs on the event loop (motor is loop-bound); the compute thread stays Mongo-free."""
        while True:
            await asyncio.sleep(FLUSH_INTERVAL_S)
            try:
                doc = await self._db['validation_jobs'].find_one({'_id': job_id}, {'cancelRequested': 1})
                if doc and doc.get('cancelRequested'):
                    sink.request_cancel()
                await self._db['validation_jobs'].update_one(
                    {'_id': job_id}, {'$set': {'progress': sink.snapshot()}})
            except Exception:
                traceback.print_exc()

    async def _terminal(self, job, status: str, *, report=None, progress=None,
                        error=None, tb=None) -> None:
        upd: dict = {'status': status, f'{status}At': _now()}
        if progress is not None:
            upd['progress'] = progress
        if report is not None:
            upd['report'] = report
            upd['summary'] = _compact_summary(report)
        if error is not None:
            upd['error'] = error
        if tb is not None:
            upd['traceback'] = tb
        await self._db['validation_jobs'].update_one({'_id': job['_id']}, {'$set': upd})
