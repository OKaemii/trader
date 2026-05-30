"""backtest-engine — real walk-forward validator (Phase 4).

`run_backtest` is a thin orchestrator over quant-core's `Replay` plus the in-tree statistics
modules. It replaces the synthetic placeholder with a genuine replay over multi-year adjusted
daily history:

  1. Resolve the universe (curated S&P 100 default + request `tickers[]`) and benchmark.
  2. Prefetch adjusted daily bars for the whole window from Yahoo (the research path —
     decoupled from the live TwelveData credit budget; see YahooDailyBarsReader).
  3. Walk-forward: per fold, grid-search the strategy's parameter_space in-sample, lock the
     best params, evaluate out-of-sample. Concatenate OOS → IC series + net-of-cost returns.
  4. Ablations (factor subsets, expressed as parameter presets) become the competing-config
     matrix for the *fixed* CSCV PBO and the DSR trial count.
  5. validate_strategy on the REAL arrays + a benchmark overlay. Persist engine='replay'.

If the data window cannot support the folds, it returns `insufficient_history` honestly — it
never fabricates a pass (the live-trading gate is cleared by a human reading `passed`).

The replay/grid loop is CPU-bound (numpy/scipy over hundreds of rebalances); it runs in a
worker thread via asyncio.to_thread so the FastAPI event loop (and /health) stays responsive.
The heavier MCPT job queue is Phase 5.
"""
import asyncio
import math
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

import motor.motor_asyncio
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .application.benchmark import benchmark_overlay
from .application.grid_search import expand_grid, grid_search, replay_path
from .application.hypothesis_testing import validate_strategy
from .application.job_runner import JobRunner
from .application.model_version_store import RETRAINING_POLICY
from .application.objectives import make_sharpe
from .application.regime import classify_regime, regime_label
from .application.replay_pnl import PriceSeries, series_period_returns
from .application.validator import DEFAULT_BENCHMARK_TICKERS, Validator
from .application.walk_forward import WalkForwardValidator

MONGODB_URL = os.getenv('MONGODB_URL', 'mongodb://localhost:27017')
MONGODB_DB  = os.getenv('MONGODB_DB', 'trader')
INTERNAL_TOKEN = os.getenv('INTERNAL_SERVICE_TOKEN', '')

# Curated S&P 100 default — mirrors UNIVERSE_INCLUDE_US in infra/helm/trader/values.yaml. These
# are the *current* constituents, so a multi-year run carries survivorship bias (only names
# that survived to today). Point-in-time membership + delistings land in Phase 6; until then
# the report stamps this caveat in `data_source`. Request `tickers[]` overrides this default.
DEFAULT_SP100 = [
    'AAPL', 'ABBV', 'ABT', 'ACN', 'ADBE', 'AIG', 'AMD', 'AMGN', 'AMT', 'AMZN', 'AVGO', 'AXP',
    'BA', 'BAC', 'BK', 'BKNG', 'BLK', 'BMY', 'BRKB', 'C', 'CAT', 'CHTR', 'CL', 'CMCSA', 'COF',
    'COP', 'COST', 'CRM', 'CSCO', 'CVS', 'CVX', 'DE', 'DHR', 'DIS', 'DOW', 'DUK', 'EMR', 'F',
    'FDX', 'GD', 'GE', 'GILD', 'GM', 'GOOG', 'GOOGL', 'GS', 'HD', 'HON', 'IBM', 'INTC', 'INTU',
    'ISRG', 'JNJ', 'JPM', 'KHC', 'KMI', 'KO', 'LIN', 'LLY', 'LMT', 'LOW', 'MA', 'MCD', 'MDLZ',
    'MDT', 'META', 'MMM', 'MO', 'MRK', 'MS', 'MSFT', 'NEE', 'NFLX', 'NKE', 'NVDA', 'ORCL',
    'PEP', 'PFE', 'PG', 'PM', 'PYPL', 'QCOM', 'RTX', 'SBUX', 'SCHW', 'SO', 'SPG', 'T', 'TGT',
    'TMO', 'TMUS', 'TSLA', 'TXN', 'UNH', 'UNP', 'UPS', 'USB', 'V', 'VZ', 'WBA', 'WFC', 'WMT', 'XOM',
]

DAY_MS = 86_400_000
N_FOLDS = 5
EMBARGO_DAYS = 21
MIN_OOS_PERIODS = 8          # below this the OOS stats are noise → insufficient_history
MIN_TRAIN_PERIODS = 12

_db = None
_job_runner = None


async def _load_validation_history(req: dict):
    """Loader the JobRunner hands the validator: prefetch adjusted daily for the universe +
    benchmark suite from Yahoo (research path), returning ragged OHLCVBar lists + (optionally) the
    point-in-time constituent rows. Network runs on the event loop; the validator's CPU then runs
    off-loop in a worker thread. Returns (prices, benchmark_bars_map, constituents|None)."""
    from quant_core.bars.reader import make_bars_reader
    from quant_core.universe import active_union

    start, end = int(req['start_ms']), int(req['end_ms'])
    benchmarks = req.get('benchmark_tickers') or DEFAULT_BENCHMARK_TICKERS

    constituents = None
    if req.get('survivorship_free'):
        # Point-in-time membership from the ingested index_constituents (Phase 6). Fetch the union
        # of names that were ever in the index over the window; the validator applies membership
        # per-rebalance. Falls back to the static set if the collection isn't ingested yet.
        constituents = await _db['index_constituents'].find({'index': 'sp500'}, {'_id': 0}).to_list(length=None)
        tickers = active_union(constituents, start, end) or DEFAULT_SP100
    else:
        tickers = [t.strip() for t in (req.get('tickers') or DEFAULT_SP100) if t and t.strip()]

    reader = make_bars_reader('yahoo_daily')
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
    return prices, bench_bars, constituents


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _db, _job_runner
    client = motor.motor_asyncio.AsyncIOMotorClient(MONGODB_URL)
    _db = client[MONGODB_DB]
    # Phase 5: durable MCPT validation queue. Recover any job a prior process left mid-run
    # (replicas: 1 ⇒ a `running` row on boot is stale), then start the single in-process worker.
    # The sweep is best-effort: a transient Mongo blip at boot must not CrashLoop the pod — the
    # worker loop is itself resilient and a later restart re-attempts recovery.
    _job_runner = JobRunner(_db, _load_validation_history, lambda: Validator())
    try:
        await _job_runner.sweep_stuck()
    except Exception:
        pass
    _job_runner.start()
    try:
        yield
    finally:
        await _job_runner.stop()


app = FastAPI(title='backtest-engine', version='2.0.0', lifespan=lifespan)


@app.exception_handler(Exception)
async def _json_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """Always answer with JSON. FastAPI/Starlette's default 500 is a *plain-text* body
    ("Internal Server Error"), which the portal proxy mislabels as JSON and the browser then
    fails to parse ("JSON.parse: unexpected character at line 1 column 1"). Returning a JSON
    `detail` here lets the Research page surface the real failure instead."""
    return JSONResponse(status_code=500, content={'detail': f'{type(exc).__name__}: {exc}'})


def _safe_float(x, default: float = 0.0) -> float:
    """Coerce to a JSON-safe finite float. Starlette renders responses with allow_nan=False, so a
    NaN/Inf metric (e.g. Sharpe of a zero-variance path, IR with zero tracking error) would raise
    during serialization and turn the response into a plain-text 500. Map non-finite → default."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _sanitize_floats(obj):
    """Recursively replace non-finite floats anywhere in a dict/list with finite defaults so the
    persisted document and the response body are both valid JSON."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else 0.0
    if isinstance(obj, dict):
        return {k: _sanitize_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_floats(v) for v in obj]
    return obj


def _require_internal(token: str):
    if token != INTERNAL_TOKEN and INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail='Unauthorized')


class BacktestRequest(BaseModel):
    strategy_id: str
    data_start_ms: int               # UTC epoch ms (e.g. 2016-01-01)
    data_end_ms: int                 # UTC epoch ms (e.g. today)
    n_trials: int = 6                # informational floor; real trial count = configs evaluated
    internal_token: str = ''
    tickers: Optional[list[str]] = None   # default: curated S&P 100 (DEFAULT_SP100)
    benchmark: str = '^GSPC'              # passive comparison (S&P 500 index, adjusted)
    rebalance_days: int = 7               # weekly for the daily strategy


class BacktestResult(BaseModel):
    strategy_id: str
    passed: bool
    failures: list[str]
    oos_sharpe: float
    mean_ic: float
    deflated_sharpe: float
    pbo: float
    fdr_corrected_pvalue: float
    ablation_variants_tested: list[str]
    engine: str = 'replay'                # 'synthetic' = placeholder; 'replay' = real walk-forward
    data_source: str = ''
    benchmark: Optional[dict] = None      # BenchmarkComparison.as_dict()
    completed_at: str


# ── helpers ───────────────────────────────────────────────────────────────────────
def _ablation_param_sets(strategy_id: str) -> dict[str, dict[str, float]]:
    """Competing configs for the PBO matrix, expressed as points in the existing parameter
    space (set a factor weight to 0 to drop it) — so no concrete strategy class is imported
    here. factor_rank's natural ablations are the factor subsets; other strategies have no
    factor-subset axis in Phase 4 (→ single-config PBO = 0.5 with a note)."""
    if strategy_id == 'factor_rank_v1':
        return {
            'momentum_only': {'w_momentum': 1.0, 'w_reversal': 0.0, 'w_low_vol': 0.0},
            'mom_reversal':  {'w_momentum': 1.0, 'w_reversal': 1.0, 'w_low_vol': 0.0},
            'mom_lowvol':    {'w_momentum': 1.0, 'w_reversal': 0.0, 'w_low_vol': 1.0},
            'full':          {'w_momentum': 1.0, 'w_reversal': 1.0, 'w_low_vol': 1.0},
        }
    return {}


def _regime_series(bench: PriceSeries, bounds: list[tuple[int, int]], window_days: int = 60) -> np.ndarray:
    """One discrete regime label per OOS period, from the benchmark's trailing daily returns
    (a cheap market-regime proxy). p_crisis stays 0 here — crisis detection needs the live
    topology β₁ signal that the offline replay doesn't compute — so labels are the
    bull/bear × low/high-vol quadrant. Aligned 1:1 with the OOS return periods."""
    import bisect
    closes = np.asarray(bench.close, dtype=float)
    labels: list[str] = []
    for t0, _t1 in bounds:
        i = bisect.bisect_right(bench.ts, t0)
        win = closes[max(0, i - window_days - 1):i]
        if len(win) >= 22:
            rets = np.diff(np.log(win))
            labels.append(regime_label(classify_regime(rets[None, :])))
        else:
            labels.append('unknown')
    return np.array(labels)


async def _walk_forward(strategy_id, reader, prices, bench, benchmark_name, folds, step, universe, round_trip_bps, ppy):
    """The CPU-bound core (driven by asyncio.run inside a worker thread). Returns a plain dict
    of everything the response + persisted doc need — no FastAPI/Mongo objects cross back. On a
    too-thin realised path it returns {'insufficient': reason} rather than running stats on
    noise (or crashing a t-test on an empty array)."""
    from quant_core.strategy.factory import make_strategy

    universe_at = lambda _t: universe  # static universe (survivorship caveat stamped upstream)
    grid = expand_grid(make_strategy(strategy_id).parameter_space())
    ablations = _ablation_param_sets(strategy_id)
    sharpe_obj = make_sharpe(ppy)   # the walk-forward IS fit selects on annualised Sharpe

    # ── Primary: per-fold IS grid search → OOS, concatenated. ──────────────────────
    primary_net: list[float] = []
    primary_ic: list[float] = []
    primary_bounds: list[tuple[int, int]] = []
    is_sharpes: list[float] = []
    for f in folds:
        gs = await grid_search(strategy_id, reader, prices, grid,
                               f.train_start, f.train_end, step, universe_at, sharpe_obj, round_trip_bps)
        is_sharpes.append(gs.best_objective)
        oos = await replay_path(strategy_id, reader, prices, gs.best_params,
                                f.test_start, f.test_end, step, universe_at, round_trip_bps)
        primary_net.extend(oos.net_returns)
        primary_ic.extend(oos.ic_series)
        primary_bounds.extend(oos.period_bounds)

    # ── Ablations: OOS over the same folds (fixed preset params), for the PBO matrix. ──
    ablation_rows: dict[str, list[float]] = {}
    for label, params in ablations.items():
        row: list[float] = []
        for f in folds:
            oos = await replay_path(strategy_id, reader, prices, params,
                                    f.test_start, f.test_end, step, universe_at, round_trip_bps)
            row.extend(oos.net_returns)
        ablation_rows[label] = row

    # PBO competing-config matrix = primary (grid-tuned) + each ablation, aligned to a common
    # period count. n_trials deflates DSR for the total configs evaluated (grid + ablations).
    rows = [primary_net] + list(ablation_rows.values())
    common = min((len(r) for r in rows if r), default=0)
    pbo_matrix = np.asarray([r[:common] for r in rows], dtype=float) if common >= 2 and len(rows) >= 2 else None
    n_trials = max(2, len(grid) + len(ablations))

    notes: list[str] = [
        'Universe is current index membership — survivorship bias (point-in-time constituents = Phase 6).',
        'Covariance-conditioning gate skipped: it governs the live held-set optimiser, not OOS validation.',
    ]
    if pbo_matrix is None:
        notes.append('PBO not estimated (single config or too few aligned OOS periods) — reported as 0.5.')

    oos_returns = np.asarray(primary_net, dtype=float)
    ic_series = np.asarray(primary_ic, dtype=float)
    # Guard the stats: a t-test/Sharpe on a near-empty path is meaningless (and ttest on an
    # empty array raises). The pre-flight fold/price checks make this rare, but degrade
    # honestly to insufficient_history rather than emit a noisy or crashing report.
    if len(oos_returns) < MIN_OOS_PERIODS or len(ic_series) < 3:
        return {'insufficient': (f'realised only {len(oos_returns)} OOS periods / '
                                 f'{len(ic_series)} IC observations after replay')}

    regime_series = _regime_series(bench, primary_bounds)
    is_sharpe = float(np.mean(is_sharpes)) if is_sharpes else 0.0

    report = validate_strategy(
        ic_series=ic_series,
        oos_returns=oos_returns,
        is_sharpe=is_sharpe,
        n_trials=n_trials,
        regime_series=regime_series,
        covariance_matrix=None,
        pbo_returns_matrix=pbo_matrix,
        periods_per_year=ppy,
    )

    bench_returns = np.asarray(series_period_returns(bench, primary_bounds), dtype=float)
    overlay = benchmark_overlay(oos_returns, bench_returns, benchmark=benchmark_name, periods_per_year=ppy)

    report.context_notes = notes
    return {
        'report': report,
        'benchmark': overlay,
        'n_trials': n_trials,
        'is_sharpe': is_sharpe,
        'oos_periods': int(len(oos_returns)),
        'ic_periods': int(len(ic_series)),
        'ablation_labels': ['primary'] + list(ablation_rows.keys()),
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _persist_result(strategy_id, universe, data_source, doc_extra):
    await _db['backtest_results'].insert_one({
        'strategy_id':   strategy_id,
        'universe_size': len(universe),
        'data_source':   data_source,
        'engine':        'replay',
        'run_at':        datetime.now(timezone.utc),
        **doc_extra,
    })


async def _insufficient(req: BacktestRequest, universe, data_source, reason):
    failures = [f'insufficient_history: {reason}']
    await _persist_result(req.strategy_id, universe, data_source, {
        'passed': False, 'failures': failures,
        'oos_sharpe': 0.0, 'mean_ic': 0.0, 'dsr': 0.0, 'pbo': 0.5, 'fdr_p': 1.0,
        'regime_breakdown': {}, 'n_trials': req.n_trials, 'benchmark': None,
    })
    return BacktestResult(
        strategy_id=req.strategy_id, passed=False, failures=failures,
        oos_sharpe=0.0, mean_ic=0.0, deflated_sharpe=0.0, pbo=0.5, fdr_corrected_pvalue=1.0,
        ablation_variants_tested=[], engine='replay', data_source=data_source,
        benchmark=None, completed_at=_now_iso(),
    )


@app.post('/admin/api/backtest/run', response_model=BacktestResult)
async def run_backtest(req: BacktestRequest):
    _require_internal(req.internal_token)

    from quant_core.bars.reader import make_bars_reader

    universe = [t.strip() for t in (req.tickers or DEFAULT_SP100) if t and t.strip()]
    benchmark = req.benchmark or '^GSPC'
    step = max(1, req.rebalance_days) * DAY_MS
    ppy = max(1, round(365.0 / max(1, req.rebalance_days)))
    data_source = (f"yahoo_daily adjusted; universe={'request' if req.tickers else 'sp100_default'} "
                   f"(current-membership, survivorship-biased); benchmark={benchmark}")

    if req.data_end_ms <= req.data_start_ms:
        raise HTTPException(status_code=400, detail='data_end_ms must be after data_start_ms')

    # Fold geometry first — fail fast before any network if the window can't support folds.
    folds = WalkForwardValidator(req.data_start_ms, req.data_end_ms, N_FOLDS, EMBARGO_DAYS).valid_folds(
        min_oos_ms=MIN_OOS_PERIODS * step, min_train_ms=MIN_TRAIN_PERIODS * step,
    )
    if len(folds) < 2:
        return await _insufficient(req, universe, data_source,
                                   f'window {(req.data_end_ms - req.data_start_ms) // DAY_MS}d yields '
                                   f'{len(folds)} valid folds (need ≥2 with a {EMBARGO_DAYS}d embargo)')

    # Prefetch adjusted daily for universe + benchmark (network, on the event loop).
    reader = make_bars_reader('yahoo_daily')
    await reader.prefetch(universe + [benchmark], req.data_start_ms, req.data_end_ms)

    prices: dict[str, PriceSeries] = {}
    for t in universe:
        bars = await reader.daily_bars(t, req.data_start_ms, req.data_end_ms)
        if bars:
            prices[t] = PriceSeries.from_bars(bars)
    bench_bars = await reader.daily_bars(benchmark, req.data_start_ms, req.data_end_ms)
    if len(prices) < 5 or not bench_bars:
        return await _insufficient(req, universe, data_source,
                                   f'only {len(prices)} tickers and '
                                   f'{"a" if bench_bars else "no"} benchmark resolved on Yahoo')
    bench = PriceSeries.from_bars(bench_bars)

    # Round-trip cost per unit one-way turnover ≈ 2·(half-spread 5bps + commission 1bps).
    round_trip_bps = float(os.getenv('BACKTEST_ROUND_TRIP_BPS', '12'))

    def _thread_entry():
        return asyncio.run(_walk_forward(
            req.strategy_id, reader, prices, bench, benchmark, folds, step,
            list(prices.keys()), round_trip_bps, ppy,
        ))

    out = await asyncio.to_thread(_thread_entry)
    if out.get('insufficient'):
        return await _insufficient(req, universe, data_source, out['insufficient'])
    report = out['report']
    overlay = out['benchmark']
    # Sanitize before persist *and* response: a non-finite metric would otherwise crash JSON
    # serialization (allow_nan=False) and surface as an opaque plain-text 500 in the portal.
    bench_dict = _sanitize_floats(overlay.as_dict())

    await _persist_result(req.strategy_id, universe, data_source, _sanitize_floats({
        'passed': report.passed,
        'failures': report.failures,
        'context_notes': report.context_notes,
        'oos_sharpe': report.oos_sharpe,
        'mean_ic': report.mean_ic,
        'ic_hit_rate': report.ic_hit_rate,
        'dsr': report.deflated_sharpe,
        'pbo': report.pbo,
        'fdr_p': report.fdr_corrected_pvalue,
        'max_drawdown': report.max_drawdown,
        'cvar_95': report.cvar_95,
        'regime_breakdown': report.regime_breakdown,
        'n_trials': out['n_trials'],
        'benchmark': bench_dict,
        'diagnostics': {
            'oos_periods': out['oos_periods'], 'ic_periods': out['ic_periods'],
            'folds': len(folds), 'rebalance_days': req.rebalance_days,
            'data_start_ms': req.data_start_ms, 'data_end_ms': req.data_end_ms,
        },
    }))

    return BacktestResult(
        strategy_id=req.strategy_id,
        passed=report.passed,
        failures=report.failures,
        oos_sharpe=_safe_float(report.oos_sharpe),
        mean_ic=_safe_float(report.mean_ic),
        deflated_sharpe=_safe_float(report.deflated_sharpe),
        pbo=_safe_float(report.pbo, 0.5),
        fdr_corrected_pvalue=_safe_float(report.fdr_corrected_pvalue, 1.0),
        ablation_variants_tested=out['ablation_labels'],
        engine='replay',
        data_source=data_source,
        benchmark=bench_dict,
        completed_at=_now_iso(),
    )


@app.get('/admin/api/backtest/results')
async def get_results(strategy_id: str = '', limit: int = 10):
    query = {'strategy_id': strategy_id} if strategy_id else {}
    results = await _db['backtest_results'].find(query).sort('run_at', -1).limit(limit).to_list(length=limit)
    for r in results:
        r.pop('_id', None)
        if 'run_at' in r and hasattr(r['run_at'], 'isoformat'):
            r['run_at'] = r['run_at'].isoformat()
    return {'results': results}


# ── Phase 5: MCPT validation jobs (queued; run by the in-process JobRunner) ──────────
class ValidationRunRequest(BaseModel):
    strategy_id: str
    start_ms: int                          # UTC epoch ms
    end_ms: int
    train_years: float = 0.0               # 0 ⇒ 50/50 in-sample/out-of-sample split
    mcpt_n_in_sample: int = 1000           # Masters' practical minimum for a clean histogram
    mcpt_n_wf: int = 200                   # walk-forward MCPT is ~order-of-magnitude costlier
    objective_name: str = 'profit_factor'  # profit_factor | sharpe | cum_return | ic_mean
    benchmark_tickers: Optional[list[str]] = None   # default: SPY + 11 sector SPDRs
    tickers: Optional[list[str]] = None    # default: curated S&P 100 (ignored if survivorship_free)
    survivorship_free: bool = False        # use point-in-time index_constituents membership (Phase 6)
    rebalance_days: int = 7
    n_folds: int = 5
    embargo_days: int = 21
    internal_token: str = ''


_JOB_TIME_FIELDS = ('createdAt', 'claimedAt', 'completedAt', 'failedAt', 'sweptAt')


def _isoify_job(job: dict) -> dict:
    job['_id'] = str(job['_id'])
    for k in _JOB_TIME_FIELDS:
        if k in job and hasattr(job[k], 'isoformat'):
            job[k] = job[k].isoformat()
    return job


@app.post('/admin/api/validator/run')
async def submit_validation(req: ValidationRunRequest):
    """Enqueue an MCPT validation job and return its id immediately — the run itself is hours
    of compute, drained by the background JobRunner. Poll GET /admin/api/validator/jobs/:id."""
    _require_internal(req.internal_token)
    if req.end_ms <= req.start_ms:
        raise HTTPException(status_code=400, detail='end_ms must be after start_ms')
    request = req.model_dump(exclude={'internal_token'})
    doc = {
        'strategy_id': req.strategy_id,
        'status': 'queued',
        'request': request,
        'createdAt': datetime.now(timezone.utc),
    }
    res = await _db['validation_jobs'].insert_one(doc)
    return {'job_id': str(res.inserted_id), 'status': 'queued'}


@app.get('/admin/api/validator/jobs/{job_id}')
async def get_validation_job(job_id: str):
    from bson import ObjectId
    from bson.errors import InvalidId
    try:
        oid = ObjectId(job_id)
    except (InvalidId, TypeError):
        raise HTTPException(status_code=400, detail='invalid job id')
    job = await _db['validation_jobs'].find_one({'_id': oid})
    if not job:
        raise HTTPException(status_code=404, detail='job not found')
    return _isoify_job(job)


@app.get('/admin/api/validator/jobs')
async def list_validation_jobs(limit: int = 20):
    # Exclude the (large) report body from the list view; fetch it via the by-id endpoint.
    cursor = _db['validation_jobs'].find({}, {'report': 0}).sort('createdAt', -1).limit(limit)
    jobs = await cursor.to_list(length=limit)
    return {'jobs': [_isoify_job(j) for j in jobs]}


def _health():
    return {'status': 'ok', 'service': 'backtest-engine', 'retraining_policy': RETRAINING_POLICY}


@app.get('/health')
async def health():
    return _health()


@app.get('/admin/api/backtest/health')
async def backtest_health_aliased():
    # Prefix-aliased health for the portal fan-out (nginx-ingress routes by prefix only).
    return _health()
