"""Walk-forward backtest as a queued job — extracted from `main.py` so the process-pool workers
import a side-effect-free module (importing `main.py` would build the FastAPI app + motor client).

`run_backtest_job` is the compute entry (worker thread, Mongo-free). It parallelises at **replay
granularity** so a many-core box isn't capped at `n_folds`:

  wave 1 — `folds × |grid|` in-sample replays → per-fold best params (Sharpe-selected);
  wave 2 — `n_folds` primary OOS replays + `ablations × n_folds` ablation OOS replays;
  scoring — PBO / DSR / IC gates + benchmark overlay (serial, cheap).

`_load_backtest_history` (event loop) prefetches adjusted daily bars, resolves the portal grid
override, and materialises everything into a fully-picklable ctx; the workers rebuild an
`InMemoryBarsReader` from it (same substrate the MCPT validator uses — behaviour-equivalent to the
old warm `YahooDailyBarsReader`, just serialisable).
"""
from __future__ import annotations

import bisect
import math
import os
from datetime import datetime, timezone

import numpy as np

from quant_core.bars.in_memory_reader import InMemoryBarsReader
from quant_core.strategy.factory import make_strategy

from .benchmark import benchmark_overlay
from .grid_search import expand_grid, replay_path
from .hypothesis_testing import validate_strategy
from .objectives import make_sharpe
from .parallel import drive_coro, make_parallel_map
from .progress import NullProgress, ProgressSink
from .regime import classify_regime, regime_label
from .replay_pnl import PriceSeries, series_period_returns
from .walk_forward import WalkForwardValidator

DAY_MS = 86_400_000
N_FOLDS = 5
EMBARGO_DAYS = 21
MIN_OOS_PERIODS = 8          # below this the OOS stats are noise → insufficient_history
MIN_TRAIN_PERIODS = 12

_PRIMARY = '__primary__'     # OOS-task tag for the grid-tuned primary path (vs an ablation label)

# Curated S&P 100 default — mirrors UNIVERSE_INCLUDE_US in infra/helm/trader/values.yaml. Current
# constituents, so a multi-year run carries survivorship bias; point-in-time membership is the
# MCPT validator's `survivorship_free` path. Request `tickers[]` overrides this default. Shared by
# the MCPT loader in main.py (imported there to avoid a main↔backtest_run import cycle).
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


def _safe_float(x, default: float = 0.0) -> float:
    """Coerce to a JSON-safe finite float (Starlette renders with allow_nan=False)."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def _sanitize_floats(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else 0.0
    if isinstance(obj, dict):
        return {k: _sanitize_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_floats(v) for v in obj]
    return obj


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ablation_param_sets(strategy_id: str) -> dict[str, dict[str, float]]:
    """Competing configs for the PBO matrix, as points in the existing parameter space (a factor
    weight = 0 drops it) — so no concrete strategy class is imported here."""
    if strategy_id == 'factor_rank_v1':
        return {
            'momentum_only': {'w_momentum': 1.0, 'w_reversal': 0.0, 'w_low_vol': 0.0},
            'mom_reversal':  {'w_momentum': 1.0, 'w_reversal': 1.0, 'w_low_vol': 0.0},
            'mom_lowvol':    {'w_momentum': 1.0, 'w_reversal': 0.0, 'w_low_vol': 1.0},
            'full':          {'w_momentum': 1.0, 'w_reversal': 1.0, 'w_low_vol': 1.0},
        }
    return {}


def _regime_series(bench: PriceSeries, bounds: list[tuple[int, int]], window_days: int = 60) -> np.ndarray:
    """One discrete regime label per OOS period from the benchmark's trailing daily returns (a
    cheap market-regime proxy). p_crisis stays 0 (needs the live topology β₁ signal)."""
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


# ── module-level backtest workers (picklable for `spawn`; read a worker-global ctx) ───
_BT_CTX: dict | None = None


def _init_backtest_worker(ctx: dict) -> None:
    """Build the reader + price series once per worker process (not per task)."""
    global _BT_CTX
    reader = InMemoryBarsReader(ctx['bars'])
    prices = {t: PriceSeries.from_bars(b) for t, b in ctx['bars'].items()}
    _BT_CTX = {**ctx, '_reader': reader, '_prices': prices}
    from quant_core.wiring import set_replay_fundamentals
    set_replay_fundamentals(ctx.get('fundamentals'))   # point-in-time-approx QMJ snapshot (spawn-safe)


def _backtest_isfit_worker(task):
    """One in-sample replay at (fold, grid-point) → (fold, param_index, Sharpe | None)."""
    fold_i, param_i = task
    ctx = _BT_CTX
    f = ctx['folds'][fold_i]
    params = ctx['grid'][param_i]
    universe_at = lambda _t: ctx['universe']   # noqa: E731 — built in-worker; never pickled
    sharpe = make_sharpe(ctx['ppy'])
    oos = drive_coro(lambda: replay_path(ctx['strategy_id'], ctx['_reader'], ctx['_prices'], params,
                                         f.train_start, f.train_end, ctx['step'], universe_at, ctx['rt']))
    obj = sharpe(oos) if len(oos.net_returns) >= 2 else None
    return (fold_i, param_i, obj)


def _backtest_oos_worker(task):
    """One out-of-sample replay at fixed params → (fold, tag, net, ic, bounds)."""
    fold_i, params, tag = task
    ctx = _BT_CTX
    f = ctx['folds'][fold_i]
    universe_at = lambda _t: ctx['universe']   # noqa: E731
    oos = drive_coro(lambda: replay_path(ctx['strategy_id'], ctx['_reader'], ctx['_prices'], params,
                                         f.test_start, f.test_end, ctx['step'], universe_at, ctx['rt']))
    return (fold_i, tag, list(oos.net_returns), list(oos.ic_series), list(oos.period_bounds))


def _insufficient_report(req: dict, ctx: dict, reason: str) -> dict:
    return _sanitize_floats({
        'strategy_id': ctx.get('strategy_id') or req.get('strategy_id'), 'engine': 'replay',
        'passed': False, 'failures': [f'insufficient_history: {reason}'], 'context_notes': [],
        'oos_sharpe': 0.0, 'mean_ic': 0.0, 'ic_hit_rate': 0.0, 'deflated_sharpe': 0.0,
        'pbo': 0.5, 'fdr_corrected_pvalue': 1.0, 'max_drawdown': 0.0, 'cvar_95': 0.0,
        'regime_breakdown': {}, 'n_trials': 0, 'benchmark': None, 'ablation_variants_tested': [],
        'data_source': ctx.get('data_source', ''), 'universe_size': len(ctx.get('universe', [])),
        'seed': int(req.get('seed', 0)), 'diagnostics': {}, 'completed_at': _now_iso(),
    })


async def _load_backtest_history(db, req: dict) -> dict:
    """Event loop: prefetch adjusted daily for universe + benchmark, resolve the portal grid
    override, compute fold geometry → a fully-picklable ctx for the worker pool. No live network
    or Mongo crosses into the compute thread."""
    from quant_core.bars.reader import make_bars_reader
    from ..infrastructure.strategy_config import resolve_search_grid

    strategy_id = req['strategy_id']
    start, end = int(req['data_start_ms']), int(req['data_end_ms'])
    benchmark = req.get('benchmark') or '^GSPC'
    rebalance_days = int(req.get('rebalance_days', 7))
    step = max(1, rebalance_days) * DAY_MS
    ppy = max(1, round(365.0 / max(1, rebalance_days)))
    universe = [t.strip() for t in (req.get('tickers') or DEFAULT_SP100) if t and t.strip()]
    data_source = (f"yahoo_daily adjusted; universe={'request' if req.get('tickers') else 'sp100_default'} "
                   f"(current-membership, survivorship-biased); benchmark={benchmark}")

    grid_override = await resolve_search_grid(db, strategy_id)
    grid = expand_grid(grid_override if grid_override is not None else make_strategy(strategy_id).parameter_space())
    folds = WalkForwardValidator(start, end, N_FOLDS, EMBARGO_DAYS).valid_folds(
        min_oos_ms=MIN_OOS_PERIODS * step, min_train_ms=MIN_TRAIN_PERIODS * step)

    reader = make_bars_reader('yahoo_daily')
    await reader.prefetch(universe + [benchmark], start, end)
    bars: dict[str, list] = {}
    for t in universe:
        b = await reader.daily_bars(t, start, end)
        if b:
            bars[t] = b
    bench_bars = await reader.daily_bars(benchmark, start, end)

    # Point-in-time-approximate fundamentals for high_velocity's QMJ screen (Yahoo has no as-of
    # fundamentals → current snapshot applied historically; stamped in data_source).
    fundamentals_snapshot: dict = {}
    if strategy_id == 'high_velocity_v1':
        from ..infrastructure.fundamentals_loader import load_fundamentals_snapshot
        fundamentals_snapshot = await load_fundamentals_snapshot(list(bars.keys()))
        data_source += "; fundamentals=point_in_time_approximate (current company_fundamentals applied historically)"

    return {
        'bars': bars, 'bench_bars': bench_bars or [], 'folds': folds, 'grid': grid,
        'fundamentals': fundamentals_snapshot,
        'ablations': _ablation_param_sets(strategy_id), 'strategy_id': strategy_id,
        'ppy': ppy, 'step': step, 'rt': float(os.getenv('BACKTEST_ROUND_TRIP_BPS', '12')),
        'universe': list(bars.keys()), 'benchmark': benchmark, 'data_source': data_source,
        'rebalance_days': rebalance_days, 'data_start_ms': start, 'data_end_ms': end,
    }


async def run_backtest_job(ctx: dict, req: dict, progress: ProgressSink = NullProgress()) -> dict:
    """Worker thread (Mongo-free): parallel walk-forward + serial scoring → report dict."""
    folds = ctx['folds']
    G, F, A = len(ctx['grid']), len(folds), len(ctx['ablations'])

    if F < 2:
        return _insufficient_report(req, ctx,
                                    f'window yields {F} valid folds (need ≥2 with a {EMBARGO_DAYS}d embargo)')
    if len(ctx['universe']) < 5 or not ctx['bench_bars']:
        return _insufficient_report(req, ctx,
                                    f"only {len(ctx['universe'])} tickers and "
                                    f"{'a' if ctx['bench_bars'] else 'no'} benchmark resolved on Yahoo")

    progress.set_total(F * (G + 1 + A))

    # ── wave 1: in-sample fits (fold × grid-point) → per-fold best params (Sharpe-selected) ──
    progress.set_stage('in_sample_fit')
    isfit_tasks = [(fi, pi) for fi in range(F) for pi in range(G)]
    isfit = make_parallel_map(len(isfit_tasks)).run(
        _backtest_isfit_worker, isfit_tasks, initializer=_init_backtest_worker, initargs=(ctx,),
        on_result=lambda _r: progress.tick(1), cancel=progress.raise_if_cancelled)
    best_obj: dict[int, float] = {}
    best_pi: dict[int, int] = {}
    for fi, pi, obj in isfit:                 # submission order = (fold, ascending param) ⇒ first-max tie-break
        if obj is None:
            continue
        if fi not in best_obj or obj > best_obj[fi]:
            best_obj[fi], best_pi[fi] = obj, pi
    best_params = {fi: ctx['grid'][best_pi.get(fi, 0)] for fi in range(F)}
    is_sharpes = [best_obj.get(fi, 0.0) for fi in range(F)]

    # ── wave 2: OOS replays — primary (best params) + ablations (fixed presets) ──
    progress.set_stage('out_of_sample')
    oos_tasks = [(fi, best_params[fi], _PRIMARY) for fi in range(F)]
    for lbl, params in ctx['ablations'].items():
        oos_tasks += [(fi, params, lbl) for fi in range(F)]
    oos_res = make_parallel_map(len(oos_tasks)).run(
        _backtest_oos_worker, oos_tasks, initializer=_init_backtest_worker, initargs=(ctx,),
        on_result=lambda _r: progress.tick(1), cancel=progress.raise_if_cancelled)

    prim = {fi: (net, ic, bnd) for (fi, tag, net, ic, bnd) in oos_res if tag == _PRIMARY}
    primary_net: list[float] = []
    primary_ic: list[float] = []
    primary_bounds: list = []
    for fi in range(F):
        net, ic, bnd = prim[fi]
        primary_net += net
        primary_ic += ic
        primary_bounds += bnd
    ablation_net: dict[str, dict[int, list]] = {}
    for (fi, tag, net, _ic, _bnd) in oos_res:
        if tag != _PRIMARY:
            ablation_net.setdefault(tag, {})[fi] = net
    ablation_rows = {lbl: [v for fi in range(F) for v in rows.get(fi, [])]
                     for lbl, rows in ablation_net.items()}

    # ── scoring (serial; cheap) ──
    progress.set_stage('scoring')
    ppy = ctx['ppy']
    rows = [primary_net] + list(ablation_rows.values())
    common = min((len(r) for r in rows if r), default=0)
    pbo_matrix = np.asarray([r[:common] for r in rows], dtype=float) if common >= 2 and len(rows) >= 2 else None
    n_trials = max(2, G + A)
    notes = [
        'Universe is current index membership — survivorship bias (point-in-time constituents = MCPT survivorship_free).',
        'Covariance-conditioning gate skipped: it governs the live held-set optimiser, not OOS validation.',
    ]
    if pbo_matrix is None:
        notes.append('PBO not estimated (single config or too few aligned OOS periods) — reported as 0.5.')

    oos_returns = np.asarray(primary_net, dtype=float)
    ic_series = np.asarray(primary_ic, dtype=float)
    if len(oos_returns) < MIN_OOS_PERIODS or len(ic_series) < 3:
        return _insufficient_report(req, ctx, f'realised only {len(oos_returns)} OOS periods / '
                                              f'{len(ic_series)} IC observations after replay')

    bench = PriceSeries.from_bars(ctx['bench_bars'])
    regime_series = _regime_series(bench, primary_bounds)
    is_sharpe = float(np.mean(is_sharpes)) if is_sharpes else 0.0

    r = validate_strategy(
        ic_series=ic_series, oos_returns=oos_returns, is_sharpe=is_sharpe, n_trials=n_trials,
        regime_series=regime_series, covariance_matrix=None, pbo_returns_matrix=pbo_matrix,
        periods_per_year=ppy)
    r.context_notes = notes
    bench_returns = np.asarray(series_period_returns(bench, primary_bounds), dtype=float)
    bench_dict = _sanitize_floats(benchmark_overlay(oos_returns, bench_returns,
                                                    benchmark=ctx['benchmark'], periods_per_year=ppy).as_dict())

    return _sanitize_floats({
        'strategy_id': ctx['strategy_id'], 'engine': 'replay', 'passed': r.passed,
        'failures': r.failures, 'context_notes': r.context_notes,
        'oos_sharpe': _safe_float(r.oos_sharpe), 'mean_ic': _safe_float(r.mean_ic),
        'ic_hit_rate': _safe_float(r.ic_hit_rate), 'deflated_sharpe': _safe_float(r.deflated_sharpe),
        'pbo': _safe_float(r.pbo, 0.5), 'fdr_corrected_pvalue': _safe_float(r.fdr_corrected_pvalue, 1.0),
        'max_drawdown': _safe_float(r.max_drawdown), 'cvar_95': _safe_float(r.cvar_95),
        'regime_breakdown': r.regime_breakdown, 'n_trials': n_trials, 'benchmark': bench_dict,
        'ablation_variants_tested': ['primary'] + list(ablation_rows.keys()),
        'data_source': ctx['data_source'], 'universe_size': len(ctx['universe']),
        'seed': int(req.get('seed', 0)),
        'diagnostics': {'oos_periods': int(len(oos_returns)), 'ic_periods': int(len(ic_series)),
                        'folds': F, 'rebalance_days': ctx['rebalance_days'],
                        'data_start_ms': ctx['data_start_ms'], 'data_end_ms': ctx['data_end_ms']},
        'completed_at': _now_iso(),
    })


async def _backtest_summary_row(db, report: dict) -> None:
    """Historical `backtest_results` row (the /research table), same shape the old sync endpoint
    persisted, so existing dashboards keep working."""
    await db['backtest_results'].insert_one({
        'strategy_id': report.get('strategy_id'), 'universe_size': report.get('universe_size', 0),
        'data_source': report.get('data_source', ''), 'engine': 'replay',
        'run_at': datetime.now(timezone.utc),
        'passed': report.get('passed', False), 'failures': report.get('failures', []),
        'context_notes': report.get('context_notes', []),
        'oos_sharpe': report.get('oos_sharpe', 0.0), 'mean_ic': report.get('mean_ic', 0.0),
        'ic_hit_rate': report.get('ic_hit_rate', 0.0), 'dsr': report.get('deflated_sharpe', 0.0),
        'pbo': report.get('pbo', 0.5), 'fdr_p': report.get('fdr_corrected_pvalue', 1.0),
        'max_drawdown': report.get('max_drawdown', 0.0), 'cvar_95': report.get('cvar_95', 0.0),
        'regime_breakdown': report.get('regime_breakdown', {}), 'n_trials': report.get('n_trials', 0),
        'benchmark': report.get('benchmark'), 'diagnostics': report.get('diagnostics', {}),
        'seed': report.get('seed', 0),
    })
