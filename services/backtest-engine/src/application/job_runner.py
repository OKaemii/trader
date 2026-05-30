"""JobRunner — durable async queue for the hours-long MCPT validator.

A validation run is far too long for an HTTP handler (≈30 min in-sample, ≈3 h walk-forward for
factor_rank; ~10× for topology), so `POST /admin/api/validator/run` only enqueues a
VALIDATION_JOBS document and returns `{job_id}`. This background task — started in the FastAPI
lifespan — claims one queued job at a time (FIFO, atomic), loads bar history on the event loop,
runs the validator **off** the loop via `asyncio.to_thread` (so `/health` and the poller stay
responsive), and writes the report back.

Single-instance by deployment (backtest-engine `replicas: 1`): the startup sweep reverts any job
a previous process left `running` (a crash/rolling-restart victim) back to `queued`, so the
interrupted run resumes rather than stranding. The atomic `find_one_and_update` claim remains
correct if that ever changes — two workers would claim disjoint rows.
"""
from __future__ import annotations

import asyncio
import inspect
import traceback
from datetime import datetime, timezone
from typing import Awaitable, Callable

from pymongo import ReturnDocument

POLL_INTERVAL_S = 30
JOB_TIMEOUT_S = 24 * 60 * 60     # hard cap; a run past this is marked failed

# (request: dict) -> (prices: dict[ticker, list[OHLCVBar]], benchmark_bars: list[OHLCVBar])
LoadHistory = Callable[[dict], Awaitable[tuple]]


class JobRunner:
    def __init__(self, db, load_history: LoadHistory, make_validator: Callable[[], object]) -> None:
        self._db = db
        self._load_history = load_history
        self._make_validator = make_validator
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def sweep_stuck(self) -> int:
        """Boot recovery: re-queue jobs a prior process left mid-run (replicas: 1 ⇒ any
        `running` row on startup is stale)."""
        res = await self._db['validation_jobs'].update_many(
            {'status': 'running'},
            {'$set': {'status': 'queued', 'sweptAt': datetime.now(timezone.utc)}},
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
            {'$set': {'status': 'running', 'claimedAt': datetime.now(timezone.utc)}},
            sort=[('createdAt', 1)],
            return_document=ReturnDocument.AFTER,
        )

    async def _run_one(self, job) -> None:
        try:
            req = dict(job['request'])
            prices, bench_bars, constituents = await self._load_history(req)   # network, event loop
            validator = self._make_validator()
            # Forward only the request keys validator.run actually accepts. A job queued under an
            # older request schema (a renamed/removed field — e.g. Phase-5's `benchmark`, now
            # `benchmark_tickers`) then re-runs best-effort under the current schema instead of
            # crashing on an unexpected kwarg. Loader-only keys (`tickers`/`survivorship_free`,
            # resolved into prices/constituents above) and the explicitly-passed positional/
            # `constituents` args are excluded by construction.
            accepted = set(inspect.signature(validator.run).parameters) - {'prices', 'benchmark_bars', 'constituents'}
            run_kwargs = {k: v for k, v in req.items() if k in accepted}
            ignored = [k for k in req if k not in accepted]
            if ignored:
                print(f"validation job {job.get('_id')}: ignoring request keys not on validator.run {ignored}")

            def _entry():
                return asyncio.run(validator.run(prices, bench_bars, constituents=constituents, **run_kwargs))

            report = await asyncio.wait_for(asyncio.to_thread(_entry), timeout=JOB_TIMEOUT_S)

            await self._db['validation_jobs'].update_one(
                {'_id': job['_id']},
                {'$set': {'status': 'completed', 'report': report,
                          'completedAt': datetime.now(timezone.utc)}},
            )
            await self._db['backtest_results'].insert_one(_summary_row(report))
        except Exception as e:  # noqa: BLE001 — record every failure on the job, never crash the loop
            await self._db['validation_jobs'].update_one(
                {'_id': job['_id']},
                {'$set': {'status': 'failed', 'error': str(e),
                          'traceback': traceback.format_exc(),
                          'failedAt': datetime.now(timezone.utc)}},
            )


def _summary_row(report: dict) -> dict:
    """Back-compat backtest_results row so the existing /research table lists MCPT runs too."""
    legacy = report.get('legacy_gates') or {}
    step2 = report.get('step2_in_sample_mcpt') or {}
    step4 = report.get('step4_walk_forward_mcpt') or {}
    overlays = report.get('benchmark_overlays') or []
    return {
        'strategy_id': report.get('strategy_id'),
        'engine': report.get('engine', 'replay_mcpt'),
        'passed': report.get('passed', False),
        'failures': report.get('failures', []),
        'oos_sharpe': legacy.get('oos_sharpe', 0.0),
        'mean_ic': legacy.get('mean_ic', 0.0),
        'dsr': legacy.get('deflated_sharpe', 0.0),
        'pbo': legacy.get('pbo', 0.5),
        'fdr_p': legacy.get('fdr_corrected_pvalue', 1.0),
        'n_trials': step4.get('n_permutations', 0),
        'universe_size': report.get('universe_size_at_run', 0),
        'benchmark': overlays[0] if overlays else None,   # primary (SPY) overlay for the table
        'data_source': report.get('data_source', ''),
        'data_quality': report.get('data_quality', ''),
        'mcpt_in_sample_quasi_p': step2.get('quasi_p'),
        'mcpt_walk_forward_quasi_p': step4.get('quasi_p'),
        'run_at': datetime.now(timezone.utc),
    }
