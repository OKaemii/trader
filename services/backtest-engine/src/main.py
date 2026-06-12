"""backtest-engine — queued validation + walk-forward backtest jobs.

Both the MCPT validator and the walk-forward backtest are far too long for an HTTP handler, so the
endpoints only **enqueue** a `validation_jobs` document (tagged with a `kind`) and return
`{job_id}`; the in-process `JobRunner` drains the one queue, dispatching on `kind` to an injected
`JobHandler`. The compute (parallelised across cores) runs off the event loop in a worker thread;
progress + cooperative cancellation flow through a `ThreadSafeProgress` the runner flushes to Mongo.

This module is deliberately thin — the backtest orchestration lives in `application/backtest_run.py`
and the validator in `application/validator.py`, so the process-pool workers import those
side-effect-free modules rather than this FastAPI app.
"""
import asyncio
import inspect
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import motor.motor_asyncio
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .infrastructure.deepseek_explainer import explain_report, is_available as deepseek_available

from .application.backtest_run import (
    DEFAULT_SP100, _backtest_summary_row, _load_backtest_history, run_backtest_job,
)
from .application.job_runner import JobHandler, JobRunner
from .application.model_version_store import RETRAINING_POLICY
from .application.validator import DEFAULT_BENCHMARK_TICKERS, Validator

MONGODB_URL = os.getenv('MONGODB_URL', 'mongodb://localhost:27017')
MONGODB_DB = os.getenv('MONGODB_DB', 'trader')
INTERNAL_TOKEN = os.getenv('INTERNAL_SERVICE_TOKEN', '')
# The PIT fundamentals lake (per-CIK Parquet) read-only mount for warehouse-source backtests. The
# harvester owns the RW mount; backtest-engine mounts it RO (the k8s mount lands in Task 22). Until
# the harvester has bootstrapped, the lake store degrades a cold path to {} per name (a degraded —
# not broken — backtest), so the default points at the eventual mount path with no further guard.
FUNDAMENTALS_LAKE_DIR = os.getenv('FUNDAMENTALS_LAKE_DIR', '/srv/fundamentals-lake')

_db = None
_job_runner = None


# ── MCPT job handler (load → run → summarize) ────────────────────────────────────────
async def _load_validation_history(req: dict) -> dict:
    """Event loop: prefetch adjusted daily for the universe + benchmark suite from EODHD `/eod`
    (the research price path — the same provider the live persisted daily series uses), resolve the
    portal grid override, and (optionally) the point-in-time constituent rows. Returns a
    fully-picklable ctx for the off-loop validator."""
    from quant_core.bars.reader import make_bars_reader
    from quant_core.universe import active_union
    from .infrastructure.strategy_config import resolve_search_grid

    start, end = int(req['start_ms']), int(req['end_ms'])
    benchmarks = req.get('benchmark_tickers') or DEFAULT_BENCHMARK_TICKERS

    constituents = None
    if req.get('survivorship_free'):
        constituents = await _db['index_constituents'].find({'index': 'sp500'}, {'_id': 0}).to_list(length=None)
        tickers = active_union(constituents, start, end) or DEFAULT_SP100
    else:
        tickers = [t.strip() for t in (req.get('tickers') or DEFAULT_SP100) if t and t.strip()]

    reader = make_bars_reader('eodhd_daily')
    await reader.prefetch(list(dict.fromkeys([*tickers, *benchmarks])), start, end)
    prices: dict[str, list] = {}
    for t in tickers:
        bars = await reader.daily_bars(t, start, end)
        if bars:
            prices[t] = bars
    bench_bars: dict[str, list] = {}
    for bt in benchmarks:
        bars = await reader.daily_bars(bt, start, end)
        if bars:
            bench_bars[bt] = bars

    grid_override = await resolve_search_grid(_db, req.get('strategy_id', 'factor_rank_v1'))

    # PIT fundamentals from the LAKE (Task 12): build the lake-backed per-step provider so the
    # main-process replay reads TRUE point-in-time fundamentals (knowledge_ts ≤ as_of, market cap
    # computed price×shares×fx). The lake store + the warehouse bars connection live in the SAME
    # process (the run step is to_thread, not a process pool), so the connection-bearing provider
    # passes through ctx without pickling. Built here (load phase) so it is constructed before the
    # off-loop compute starts; a cold lake degrades to {} per name (a degraded backtest, not a break).
    pit_fundamentals = _build_pit_fundamentals(req) if req.get('fundamentals_source') == 'warehouse' else None
    return {'prices': prices, 'benchmark_bars': bench_bars, 'constituents': constituents,
            'grid_override': grid_override, 'pit_fundamentals': pit_fundamentals}


def _build_pit_fundamentals(req: dict):
    """Build a `LakePitFundamentals` over the PIT lake for a `fundamentals_source=warehouse` run
    (Task 12 — backtest reads the lake directly).

    The lake is now the single PIT fundamentals store, so replay reads it just like the live
    read-API: a per-CIK Parquet `Store` (`FUNDAMENTALS_LAKE_DIR`, RO-mounted in Task 22) supplies the
    as-of LINE ITEMS (knowledge_ts ≤ as_of, the same 14-key contract), and the market-cap PRICE leg
    reads the SAME warehouse `bars` view momentum reads (bars stay in the warehouse snapshot — only
    the fundamentals snapshot was dropped). The provider re-resolves fundamentals as-of at every
    replay step; uncovered/non-US/unknown names degrade to {} (the forward-only contract).

    BARS WIRING. quant-core's lake package has no warehouse connection, so the price leg is injected:
    a closure over the `WarehouseReader` bars view running the SAME at-or-before-as-of close query the
    warehouse reader used (`interval='daily'`, latest knowledge_ts ≤ as_of). The bars view keys on the
    T212 ticker, so the closure is handed the original ticker string (the provider passes it through).

    INJECTION GAP (carried forward, NOT fixed here — plan §7 / the Task-13 follow-up):
      • fx_to_gbp: GBP-identity default (LSE/GBP-native names compute fully; USD market caps need a
        historical GBP/USD series the warehouse doesn't yet snapshot — the FX-series gap). USD names
        drop market_cap_gbp (NaN-excluded) until an FX series is injected. This is the SAME documented
        limitation the warehouse path carried; this task does not wire the historical FX series.
    Pre-bootstrap (the harvester lands in Task 22) the lake is cold ⇒ every name degrades to {} — a
    degraded backtest, not a break (it merges incrementally; the lake fills once the harvester runs)."""
    from quant_core.fundamentals.lake.replay import LakePitFundamentals
    from quant_core.fundamentals.lake.store import Store
    from quant_core.fundamentals.warehouse import _SELECT_CLOSE_AS_OF
    from .infrastructure.duckdb_reader import WarehouseReader

    store = Store(FUNDAMENTALS_LAKE_DIR)   # cold lake (pre-bootstrap) degrades to {} per name
    reader = WarehouseReader()             # DEFAULT_WAREHOUSE_DIR; bars view (fundamentals snapshot dropped)

    def _bars_close_as_of(ticker: str, as_of_ms: int):
        """Latest daily adjusted close at/<= as_of from the warehouse `bars` view (bi-temporal) — the
        market-cap price leg. Mirrors `WarehousePitFundamentals._adjusted_close_as_of`: the same
        at-or-before-as-of `LIMIT 1` query, degrading to None on a missing/empty bars view so a cold
        warehouse never breaks the read (the market cap is simply dropped for that name)."""
        try:
            row = reader._con.execute(_SELECT_CLOSE_AS_OF, [ticker, as_of_ms, as_of_ms]).fetchone()
        except Exception:  # noqa: BLE001 — a missing/empty bars view must not break the replay read
            return None
        if not row or row[0] is None:
            return None
        return float(row[0])

    # resolver/identity is the adapter inside LakePitFundamentals; fx defaults to GBP-identity.
    return LakePitFundamentals(store, bars_close_as_of=_bars_close_as_of)


async def _run_validator(ctx: dict, req: dict, progress) -> dict:
    """Off the event loop: forward only the request keys `validator.run` accepts (so a job queued
    under an older schema re-runs best-effort), plus the resolved grid + the progress sink."""
    validator = Validator()
    accepted = set(inspect.signature(validator.run).parameters) - {
        'prices', 'benchmark_bars', 'constituents', 'progress', 'param_grid', 'pit_fundamentals'}
    run_kwargs = {k: v for k, v in req.items() if k in accepted}
    if ctx.get('grid_override') is not None:
        run_kwargs['param_grid'] = ctx['grid_override']
    # Warehouse PIT provider (ctx-built, not a request key — it holds a live DuckDB connection): only
    # forwarded when fundamentals_source=warehouse resolved one in the load phase.
    if ctx.get('pit_fundamentals') is not None:
        run_kwargs['pit_fundamentals'] = ctx['pit_fundamentals']
    return await validator.run(ctx['prices'], ctx['benchmark_bars'],
                               constituents=ctx['constituents'], progress=progress, **run_kwargs)


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
        'seed': (report.get('permutation_seed') or {}).get('base', 0),
        'mcpt_in_sample_quasi_p': step2.get('quasi_p'),
        'mcpt_walk_forward_quasi_p': step4.get('quasi_p'),
        'run_at': datetime.now(timezone.utc),
    }


async def _mcpt_summarize(db, report: dict) -> None:
    row = _summary_row(report)
    # Best-effort plain-English interpretation, cached on the row so the portal never re-queries
    # the LLM. A DeepSeek hiccup must never block the report from being recorded.
    try:
        explanation = await asyncio.to_thread(explain_report, row)
        if explanation:
            row['ai_explanation'] = explanation
    except Exception as exc:   # noqa: BLE001
        print(f"[backtest-engine] ai explanation skipped: {exc!r}", flush=True)
    await db['backtest_results'].insert_one(row)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _job_runner
    client = motor.motor_asyncio.AsyncIOMotorClient(MONGODB_URL)
    _db = client[MONGODB_DB]
    # One durable queue, two job kinds. Recover any job a prior process left mid-run (replicas: 1 ⇒
    # a `running` row on boot is stale), then start the single in-process worker. The sweep is
    # best-effort: a transient Mongo blip at boot must not CrashLoop the pod.
    handlers = {
        'mcpt': JobHandler(load=_load_validation_history, run=_run_validator, summarize=_mcpt_summarize),
        'backtest': JobHandler(load=lambda req: _load_backtest_history(_db, req),
                               run=run_backtest_job, summarize=_backtest_summary_row),
    }
    _job_runner = JobRunner(_db, handlers)
    try:
        await _job_runner.sweep_stuck()
    except Exception:
        pass
    _job_runner.start()
    try:
        yield
    finally:
        await _job_runner.stop()


app = FastAPI(title='backtest-engine', version='3.0.0', lifespan=lifespan)


@app.exception_handler(Exception)
async def _json_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Always answer with JSON. Starlette's default 500 is a *plain-text* body, which the portal
    proxy mislabels as JSON and the browser then fails to parse."""
    return JSONResponse(status_code=500, content={'detail': f'{type(exc).__name__}: {exc}'})


def _require_internal(token: str):
    if token != INTERNAL_TOKEN and INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail='Unauthorized')


def _to_oid(job_id: str):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        return ObjectId(job_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail='invalid job id')


# ── request models ────────────────────────────────────────────────────────────────────
class BacktestRequest(BaseModel):
    strategy_id: str
    data_start_ms: int                    # UTC epoch ms (e.g. 2016-01-01)
    data_end_ms: int                      # UTC epoch ms (e.g. today)
    n_trials: int = 6                     # informational floor; real trial count = configs evaluated
    internal_token: str = ''
    tickers: Optional[list[str]] = None   # default: curated S&P 100 (DEFAULT_SP100)
    benchmark: str = '^GSPC'              # passive comparison (S&P 500 index, adjusted)
    rebalance_days: int = 7               # weekly for the daily strategy
    seed: int = 0                         # recorded on the job; reserved for future stochastic ablations


class ValidationRunRequest(BaseModel):
    strategy_id: str
    start_ms: int                          # UTC epoch ms
    end_ms: int
    train_years: float = 0.0               # 0 ⇒ 50/50 in-sample/out-of-sample split
    mcpt_n_in_sample: int = 1000           # Masters' practical minimum for a clean histogram
    mcpt_n_wf: int = 200                   # walk-forward MCPT is ~order-of-magnitude costlier
    mcpt_early_stop: bool = True           # decision-bounded sequential stop (verdict-identical to full N)
    objective_name: str = 'profit_factor'  # profit_factor | sharpe | cum_return | ic_mean
    benchmark_tickers: Optional[list[str]] = None   # default: SPY + 11 sector SPDRs
    tickers: Optional[list[str]] = None    # default: curated S&P 100 (ignored if survivorship_free)
    survivorship_free: bool = False        # use point-in-time index_constituents membership
    fundamentals_source: str = 'auto'      # 'auto' (Yahoo static approximate) | 'warehouse' (true PIT
                                           # fundamentals from the PIT lake, re-resolved per step — the
                                           # request value stays 'warehouse' for API/portal compatibility)
    rebalance_days: int = 7
    n_folds: int = 5
    embargo_days: int = 21
    seed: int = 0                          # MT19937 base; 0 reproduces the original streams byte-for-byte
    internal_token: str = ''


# ── enqueue endpoints (both return {job_id}; the JobRunner drains the queue) ────────────
@app.post('/admin/api/backtest/run')
async def run_backtest(req: BacktestRequest):
    _require_internal(req.internal_token)
    if req.data_end_ms <= req.data_start_ms:
        raise HTTPException(status_code=400, detail='data_end_ms must be after data_start_ms')
    doc = {'strategy_id': req.strategy_id, 'kind': 'backtest', 'status': 'queued', 'seed': req.seed,
           'request': req.model_dump(exclude={'internal_token'}), 'createdAt': datetime.now(timezone.utc)}
    res = await _db['validation_jobs'].insert_one(doc)
    return {'job_id': str(res.inserted_id), 'status': 'queued'}


@app.post('/admin/api/validator/run')
async def submit_validation(req: ValidationRunRequest):
    _require_internal(req.internal_token)
    if req.end_ms <= req.start_ms:
        raise HTTPException(status_code=400, detail='end_ms must be after start_ms')
    doc = {'strategy_id': req.strategy_id, 'kind': 'mcpt', 'status': 'queued', 'seed': req.seed,
           'request': req.model_dump(exclude={'internal_token'}), 'createdAt': datetime.now(timezone.utc)}
    res = await _db['validation_jobs'].insert_one(doc)
    return {'job_id': str(res.inserted_id), 'status': 'queued'}


@app.post('/admin/api/validator/jobs/{job_id}/cancel')
async def cancel_validation_job(job_id: str):
    """Queued → cancelled immediately (the atomic claim only grabs status:'queued', so it's never
    run). Running → set `cancelRequested`; the flusher trips the sink's cancel event and the
    compute stops at the next loop boundary."""
    oid = _to_oid(job_id)
    res = await _db['validation_jobs'].update_one(
        {'_id': oid, 'status': 'queued'},
        {'$set': {'status': 'cancelled', 'cancelledAt': datetime.now(timezone.utc)}})
    if res.modified_count == 0:
        await _db['validation_jobs'].update_one(
            {'_id': oid, 'status': 'running'}, {'$set': {'cancelRequested': True}})
    return {'ok': True}


# ── job + results reads ─────────────────────────────────────────────────────────────────
_JOB_TIME_FIELDS = ('createdAt', 'claimedAt', 'completedAt', 'failedAt', 'cancelledAt', 'sweptAt')


def _isoify_job(job: dict) -> dict:
    job['_id'] = str(job['_id'])
    for k in _JOB_TIME_FIELDS:
        if k in job and hasattr(job[k], 'isoformat'):
            job[k] = job[k].isoformat()
    return job


@app.get('/admin/api/validator/jobs/{job_id}')
async def get_validation_job(job_id: str):
    job = await _db['validation_jobs'].find_one({'_id': _to_oid(job_id)})
    if not job:
        raise HTTPException(status_code=404, detail='job not found')
    return _isoify_job(job)


@app.get('/admin/api/validator/jobs')
async def list_validation_jobs(limit: int = 20):
    # Exclude the (large) report body from the list view; fetch it via the by-id endpoint. The
    # compact `summary` + `progress` + `request` stay so the table renders outcome/progress/params.
    cursor = _db['validation_jobs'].find({}, {'report': 0}).sort('createdAt', -1).limit(limit)
    jobs = await cursor.to_list(length=limit)
    return {'jobs': [_isoify_job(j) for j in jobs]}


@app.get('/admin/api/backtest/results')
async def get_results(strategy_id: str = '', limit: int = 10):
    query = {'strategy_id': strategy_id} if strategy_id else {}
    results = await _db['backtest_results'].find(query).sort('run_at', -1).limit(limit).to_list(length=limit)
    for r in results:
        r.pop('_id', None)
        if 'run_at' in r and hasattr(r['run_at'], 'isoformat'):
            r['run_at'] = r['run_at'].isoformat()
        expl = r.get('ai_explanation')
        if isinstance(expl, dict) and hasattr(expl.get('generated_at'), 'isoformat'):
            expl['generated_at'] = expl['generated_at'].isoformat()
    return {'results': results}


@app.post('/admin/api/backtest/results/explain')
async def explain_results(limit: int = 10):
    """Generate + cache a DeepSeek plain-English explanation for the most recent reports that don't
    have one yet. On-demand backfill: the portal calls this once and every report gains a 'What this
    means' write-up stored on its row (so we never re-query the LLM). No-op without DEEPSEEK_API_KEY."""
    if not deepseek_available():
        return {'explained': 0, 'available': False,
                'detail': 'DEEPSEEK_API_KEY not set on backtest-engine'}
    rows = await _db['backtest_results'].find(
        {'ai_explanation': {'$exists': False}},
    ).sort('run_at', -1).limit(max(1, min(limit, 25))).to_list(length=limit)
    explained = 0
    for r in rows:
        explanation = await asyncio.to_thread(explain_report, r)
        if not explanation:
            continue
        await _db['backtest_results'].update_one({'_id': r['_id']}, {'$set': {'ai_explanation': explanation}})
        explained += 1
    return {'explained': explained, 'available': True, 'scanned': len(rows)}


def _health():
    return {'status': 'ok', 'service': 'backtest-engine', 'retraining_policy': RETRAINING_POLICY}


@app.get('/health')
async def health():
    return _health()


@app.get('/admin/api/backtest/health')
async def backtest_health_aliased():
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only).
    return _health()
