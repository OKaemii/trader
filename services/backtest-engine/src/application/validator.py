"""The four-step Monte-Carlo permutation validator (Masters / Neurotrader methodology).

This is the strongest gate in the platform. Where Phase 4's walk-forward asks "is the OOS
record good?", MCPT asks the harder question "is it better than what the *same strategy and
fitting process* would have produced on signal-free data with the market's own statistics?" —
the only honest way to separate edge from curve-fitting.

  Step 1  in-sample fit       — grid-search params on the training window.
  Step 2  in-sample MCPT      — re-fit on N permuted training sets; quasi-p = P(perm fit ≥ real
                                fit). Low ⇒ the fit isn't just shaping noise.
  Step 3  walk-forward        — anchored OOS over the full window (the Phase-4 process).
  Step 4  walk-forward MCPT   — re-run the whole walk-forward on N permuted *post-training*
                                panels; quasi-p = P(perm OOS ≥ real OOS). Low ⇒ real OOS edge.

Everything runs on one aligned in-memory panel so the real objective and its permutation null
share an identical basis. The whole thing is pure compute (no Mongo); the job runner loads the
history and drives this off the event loop. Real runs are ~hours — that is why it is a queued
job, not a request handler.

Steps 2 and 4 (the dominant loops) are fanned across a process pool via `ParallelMap`, and each
stops early once the remaining permutations cannot change the pass/fail verdict at the gate
threshold (`_decision_locked`) — verdict-identical to the full N. Progress + cancellation flow
through an injected `ProgressSink`.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Optional

import numpy as np

from quant_core.bars.fundamentals_reader import PitFundamentalsBarsReader
from quant_core.bars.in_memory_reader import InMemoryBarsReader
from quant_core.strategy.factory import make_strategy
from quant_core.universe import load_constituents
from quant_core.wiring import set_replay_fundamentals
from ..infrastructure.fundamentals_loader import load_fundamentals_snapshot

from .benchmark import benchmark_overlay
from .grid_search import expand_grid, grid_search, replay_path, walk_forward_oos, _equity
from .hypothesis_testing import validate_strategy
from .objectives import make_objective
from .parallel import drive_coro, make_parallel_map
from .permutation import AlignedPanel, align_panel, panel_to_bars, permute_panel
from .progress import NullProgress, ProgressSink
from .replay_pnl import OosPath, PriceSeries, series_period_returns
from .walk_forward import forward_test_folds

DAY_MS = 86_400_000
MIN_PANEL_TICKERS = 5
MIN_OOS_PERIODS = 8
WF_SEED_OFFSET = 10_000   # keeps the IS and WF MT19937 streams disjoint (UI caps N below this)

# Benchmark suite (Phase 6): SPY + the 11 sector SPDRs — all tradeable total-return ETFs, so a
# CAPM overlay is well-defined. ^IRX (T-bill yield) is intentionally NOT here: it's a *yield
# level*, not a price, so treating its diffs as benchmark returns is meaningless; risk-free-
# adjusted metrics are a separate future addition. The request can override this list.
DEFAULT_BENCHMARK_TICKERS = ['SPY', 'XLK', 'XLF', 'XLV', 'XLY', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE', 'XLC']


# ── report shapes (serialised into the job document) ──────────────────────────────
@dataclass
class StepFit:
    best_params: dict
    objective: float
    equity: list[float]
    grid_results: list[dict]


@dataclass
class StepMcpt:
    real_objective: float
    permutation_objectives: list[float]
    quasi_p: float
    n_permutations: int
    threshold: float
    passed: bool
    early_stopped: bool = False     # stopped once the verdict was decision-locked (see _decision_locked)
    n_planned: int = 0              # the requested N (n_permutations is what actually ran)


@dataclass
class StepWalkForward:
    folds: list[dict]
    oos_objective: float
    oos_equity: list[float]
    oos_periods: int
    embargo_days: int


@dataclass
class ValidationReportV2:
    strategy_id: str
    objective_name: str
    engine: str
    data_window_ms: list
    train_window_ms: list
    universe_size_at_run: int
    data_source: str
    rebalance_days: int
    step1_in_sample_fit: dict
    step2_in_sample_mcpt: dict
    step3_walk_forward: dict
    step4_walk_forward_mcpt: dict
    benchmark_overlays: list                  # one BenchmarkComparison.as_dict() per benchmark
    legacy_gates: dict
    data_quality: str                         # universe construction + coverage stamp
    passed: bool
    permutation_seed: dict = field(default_factory=dict)   # {engine, base, wf_offset, n_in_sample, n_wf}
    failures: list[str] = field(default_factory=list)
    context_notes: list[str] = field(default_factory=list)


def _quasi_p(real: float, perms: list[float]) -> float:
    """Unbiased Monte-Carlo p-value: (1 + #{perm ≥ real}) / (1 + n). The +1 counts the real
    sample as one draw under H0, so it can never be a literal 0 (Davison & Hinkley)."""
    n = len(perms)
    if n == 0:
        return 1.0
    count = sum(1 for p in perms if p >= real)
    return (1 + count) / (1 + n)


def _decision_locked(count_ge: int, done: int, n: int, threshold: float):
    """Return the final pass/fail verdict iff the remaining (n - done) permutations cannot change
    it, else None. The full-run quasi-p = (1 + total)/(1 + n) with total ∈ [count_ge, count_ge +
    (n - done)], so its interval is [(1+count)/(1+n), (1+count+(n-done))/(1+n)]:
      lower ≥ threshold  ⇒ FAIL certain;  upper < threshold ⇒ PASS certain."""
    lo = (1 + count_ge) / (1 + n)
    hi = (1 + count_ge + (n - done)) / (1 + n)
    if lo >= threshold:
        return False
    if hi < threshold:
        return True
    return None


def _sanitize(obj):
    import math
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else 0.0
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    return obj


def _reader_and_prices(bars: dict):
    return InMemoryBarsReader(bars), {t: PriceSeries.from_bars(b) for t, b in bars.items()}


def _slice_panel(panel: AlignedPanel, end_index: int) -> AlignedPanel:
    """Prefix [0, end_index) of an aligned panel — the IS-only sub-panel. IS-MCPT must permute
    *within* this slice; permuting the full panel would pull OOS bar-relatives into the IS
    window (the shared shuffle index maps IS positions to arbitrary bars), corrupting the null."""
    return AlignedPanel(
        timestamps=panel.timestamps[:end_index],
        tickers=list(panel.tickers),
        ohlc={t: panel.ohlc[t][:end_index] for t in panel.tickers},
        volume={t: panel.volume[t][:end_index] for t in panel.tickers},
    )


def _build_universe_at(spec: dict, panel_set: set):
    """Reconstruct the (non-picklable) `universe_at` closure inside a worker from a plain spec —
    so only data crosses the process boundary, never a live closure."""
    if spec.get('kind') == 'pit':
        cons = spec['constituents']
        return lambda t: [tk for tk in load_constituents(cons, t) if tk in panel_set]
    tickers = spec['tickers']
    return lambda _t: tickers


# ── module-level MCPT workers (picklable for `spawn`; read a worker-global ctx) ───────
_WORKER_CTX: Optional[dict] = None


def _init_mcpt_worker(ctx: dict) -> None:
    global _WORKER_CTX
    _WORKER_CTX = ctx
    set_replay_fundamentals(ctx.get('fundamentals'))   # point-in-time-approx QMJ snapshot (spawn-safe)


def _is_mcpt_worker(seed: int) -> float:
    """One IS-MCPT permutation → best in-sample objective. Permutes strictly within the IS
    sub-panel so the OOS region never leaks into the null."""
    ctx = _WORKER_CTX
    panel = ctx['panel']
    is_panel = _slice_panel(panel, ctx['train_index'])
    pbars = panel_to_bars(permute_panel(is_panel, start_index=0, seed=seed))
    reader, prices = _reader_and_prices(pbars)
    objective = make_objective(ctx['objective_name'], ctx['ppy'])
    universe_at = _build_universe_at(ctx['universe_spec'], set(panel.tickers))
    gs = drive_coro(lambda: grid_search(ctx['strategy_id'], reader, prices, ctx['grid'],
                                        ctx['start_ms'], ctx['train_ms'], ctx['step'],
                                        universe_at, objective, ctx['round_trip_bps']))
    return float(gs.best_objective)


def _wf_mcpt_worker(seed: int) -> float:
    """One WF-MCPT permutation → walk-forward OOS objective. Permutes the post-training tail only,
    leaving the fitted region intact."""
    ctx = _WORKER_CTX
    panel = ctx['panel']
    pbars = panel_to_bars(permute_panel(panel, start_index=ctx['train_index'], seed=seed))
    reader, prices = _reader_and_prices(pbars)
    objective = make_objective(ctx['objective_name'], ctx['ppy'])
    universe_at = _build_universe_at(ctx['universe_spec'], set(panel.tickers))
    pwf = drive_coro(lambda: walk_forward_oos(ctx['strategy_id'], reader, prices, ctx['grid'],
                                              ctx['folds'], ctx['step'], universe_at, objective,
                                              ctx['round_trip_bps']))
    return float(objective(OosPath(net_returns=pwf.net_returns, ic_series=pwf.ic_series)))


class Validator:
    def __init__(self, *, round_trip_bps: float = 12.0) -> None:
        self._rt = round_trip_bps

    async def run(
        self,
        prices: dict,                      # ticker -> list[OHLCVBar] (real, ragged)
        benchmark_bars: dict,              # benchmark ticker -> list[OHLCVBar] (one per benchmark)
        *,
        strategy_id: str,
        start_ms: int,
        end_ms: int,
        train_years: float = 0.0,          # 0 ⇒ 50/50 split
        mcpt_n_in_sample: int = 1000,
        mcpt_n_wf: int = 200,
        objective_name: str = 'profit_factor',
        benchmark_tickers: Optional[list[str]] = None,   # overlay order/labels; default = bars keys
        constituents: Optional[list[dict]] = None,       # point-in-time membership rows (survivorship-free)
        rebalance_days: int = 7,
        n_folds: int = 5,
        embargo_days: int = 21,
        data_source: str = '',
        param_grid: Optional[dict] = None,   # portal searchGrid override; None ⇒ parameter_space()
        seed: int = 0,                       # MT19937 base; 0 reproduces the original 0.. / 10000.. streams
        mcpt_early_stop: bool = True,        # decision-bounded sequential stop (verdict-identical to full N)
        pit_fundamentals=None,               # a FundamentalsAsOf PIT provider (LakePitFundamentals over the
                                             # lake, Task 12); when set, the main-process replay reads TRUE
                                             # PIT per step (the seam is provider-agnostic — any FundamentalsAsOf)
        progress: ProgressSink = NullProgress(),
    ) -> dict:
        step = max(1, rebalance_days) * DAY_MS
        ppy = max(1, round(365.0 / max(1, rebalance_days)))
        objective = make_objective(objective_name, ppy)

        # One aligned panel underlies real + permuted runs (identical basis is what makes the
        # quasi-p meaningful). align_panel drops late-listers / non-positive series.
        panel = align_panel(prices)
        if len(panel.tickers) < MIN_PANEL_TICKERS or len(panel.timestamps) < 60:
            return self._insufficient(strategy_id, objective_name, start_ms, end_ms, data_source,
                                      f'aligned panel too small ({len(panel.tickers)} tickers, '
                                      f'{len(panel.timestamps)} bars)')

        train_ms = (start_ms + int(train_years * 365 * DAY_MS)) if train_years else (start_ms + (end_ms - start_ms) // 2)
        train_ms = min(max(train_ms, start_ms + 1), end_ms - 1)
        train_index = int(np.searchsorted(panel.timestamps, train_ms, side='right'))

        # Fold geometry up front — needed for the progress total AND the WF worker ctx; fail fast.
        folds = forward_test_folds(
            train_start=start_ms, oos_start=train_ms, oos_end=end_ms,
            n_folds=n_folds, embargo_days=embargo_days,
            min_oos_ms=MIN_OOS_PERIODS * step, min_train_ms=MIN_OOS_PERIODS * step)
        if len(folds) < 2:
            return self._insufficient(strategy_id, objective_name, start_ms, end_ms, data_source,
                                      f'window yields {len(folds)} valid folds (need ≥2)')
        n_eff_folds = len(folds)

        real_bars = panel_to_bars(panel)
        real_reader, real_prices = _reader_and_prices(real_bars)
        bench_map = {bt: PriceSeries.from_bars(b) for bt, b in (benchmark_bars or {}).items() if b}
        grid = expand_grid(param_grid if param_grid is not None else make_strategy(strategy_id).parameter_space())
        panel_set = set(panel.tickers)

        if constituents:
            # Point-in-time membership: rank only names in the index at instant t, intersected with
            # the aligned (full-coverage) panel. Delisted names whose EODHD history is too partial
            # already fell out of the panel — the free-data survivorship gap, stamped below.
            universe_spec = {'kind': 'pit', 'constituents': constituents}
            universe_kind = 'point_in_time_sp500'
        else:
            universe_spec = {'kind': 'static', 'tickers': list(panel.tickers)}
            universe_kind = 'static'
        universe_at = _build_universe_at(universe_spec, panel_set)

        data_quality = (
            f"eodhd_daily; universe={universe_kind}; panel {len(panel.tickers)}/{len(prices)} "
            f"names full-coverage; "
            + ("delisted/partial-history names dropped (free-data survivorship gap; full coverage "
               "needs a paid feed)" if constituents else "current-membership ⇒ survivorship bias")
        )

        # Fundamentals for quality-screening strategies (high_velocity). Two paths:
        #   • LAKE PIT (pit_fundamentals supplied, Task 12): wrap the main-process reader with the
        #     per-step true-PIT reader (re-resolves as-of at EVERY replay step from the PIT lake).
        #     Covered names stamp 'point_in_time'; uncovered degrade to {} (no proxy).
        #   • STATIC APPROXIMATE (default): one current `company_fundamentals` snapshot applied at
        #     every step — a documented look-ahead approximation (Yahoo has no as-of fundamentals).
        # The fail-closed QMJ screen yields an empty backtest if neither resolves — honest, not faked.
        fundamentals_snapshot: dict = {}
        if strategy_id == 'high_velocity_v1':
            if pit_fundamentals is not None:
                # True PIT: wrap ONLY the main-process reader (step-1 fit + step-3 walk-forward). The
                # MCPT workers (steps 2 & 4) permute the bars, so a per-step as-of fundamentals lookup
                # against shuffled prices is meaningless there — and a live DuckDB connection can't
                # cross the spawn boundary anyway; those nulls keep the spawn-safe static snapshot.
                real_reader = PitFundamentalsBarsReader(real_reader, pit_fundamentals)
                data_quality += (f"; fundamentals={PitFundamentalsBarsReader.FUNDAMENTALS_DATA_QUALITY} "
                                 "(lake PIT, re-resolved as-of per replay step; uncovered names ⇒ {}); "
                                 "MCPT permutation nulls use the static approximate snapshot")
                # Best-effort static snapshot still loaded for the spawn-safe MCPT-null path.
                fundamentals_snapshot = await load_fundamentals_snapshot(list(panel.tickers))
            else:
                fundamentals_snapshot = await load_fundamentals_snapshot(list(panel.tickers))
                data_quality += ("; fundamentals=point_in_time_approximate "
                                 "(current company_fundamentals applied historically — Yahoo has no as-of fundamentals)")
        set_replay_fundamentals(fundamentals_snapshot)   # main process: step-1 fit + step-3 walk-forward

        # Shared, fully-picklable worker ctx for the parallel MCPT stages (steps 2 & 4).
        ctx = {
            'panel': panel, 'grid': grid, 'strategy_id': strategy_id,
            'objective_name': objective_name, 'ppy': ppy, 'step': step,
            'round_trip_bps': self._rt, 'universe_spec': universe_spec,
            'start_ms': start_ms, 'train_ms': train_ms, 'train_index': train_index, 'folds': folds,
            'fundamentals': fundamentals_snapshot,
        }

        # Uniform fit-units: step1 (1) + IS-MCPT (N) + walk-forward (folds) + WF-MCPT (M·folds).
        progress.set_total(1 + mcpt_n_in_sample + n_eff_folds + mcpt_n_wf * n_eff_folds)

        def _run_mcpt_stage(stage, worker, seeds, real, n, *, threshold, tick_units):
            progress.set_stage(stage)

            def _stop(objs):
                if not mcpt_early_stop:
                    return False
                count = sum(1 for o in objs if o >= real)
                return _decision_locked(count, len(objs), n, threshold) is not None

            objs = make_parallel_map(n).run(
                worker, seeds, initializer=_init_mcpt_worker, initargs=(ctx,),
                on_result=lambda _o: progress.tick(tick_units),
                cancel=progress.raise_if_cancelled, should_stop=_stop)
            done = len(objs)
            count = sum(1 for o in objs if o >= real)
            progress.tick(tick_units * (n - done))   # close the stage's bar if it stopped early
            if done < n:
                verdict = _decision_locked(count, done, n, threshold) is True
            else:
                verdict = (1 + count) / (1 + n) < threshold
            return StepMcpt(
                real_objective=real, permutation_objectives=objs, n_permutations=done,
                quasi_p=(1 + count) / (1 + n),   # a lower bound when early-stopped (≥ threshold on a fail)
                threshold=threshold, passed=verdict, early_stopped=done < n, n_planned=n)

        # ── Step 1: in-sample fit ──────────────────────────────────────────────────
        progress.set_stage('in_sample_fit')
        is_gs = await grid_search(strategy_id, real_reader, real_prices, grid,
                                  start_ms, train_ms, step, universe_at, objective, self._rt)
        is_path = await replay_path(strategy_id, real_reader, real_prices, is_gs.best_params,
                                    start_ms, train_ms, step, universe_at, self._rt)
        step1 = StepFit(best_params=is_gs.best_params, objective=is_gs.best_objective,
                        equity=_equity(is_path.net_returns), grid_results=is_gs.all_results)
        progress.tick(1)

        # ── Step 2: in-sample MCPT (parallel; permute strictly within the IS sub-panel) ──
        step2 = _run_mcpt_stage('in_sample_mcpt', _is_mcpt_worker,
                                [seed + i for i in range(mcpt_n_in_sample)], step1.objective,
                                mcpt_n_in_sample, threshold=0.01, tick_units=1)

        # ── Step 3: walk-forward — test windows roll through the OOS half [train_ms, end_ms],
        # training anchored at start_ms. This is what makes step 4's post-train permutation hit
        # every fold's OOS (and later folds' training tails). Serial; per-fold progress.
        progress.set_stage('walk_forward')
        wf = await walk_forward_oos(strategy_id, real_reader, real_prices, grid, folds, step,
                                    universe_at, objective, self._rt, progress=progress)
        real_oos_obj = objective(OosPath(net_returns=wf.net_returns, ic_series=wf.ic_series))
        step3 = StepWalkForward(folds=wf.per_fold, oos_objective=real_oos_obj,
                                oos_equity=_equity(wf.net_returns), oos_periods=len(wf.net_returns),
                                embargo_days=embargo_days)

        # ── Step 4: walk-forward MCPT (parallel; permute post-training, re-run the walk-forward) ──
        oos_years = (end_ms - train_ms) / (365 * DAY_MS)
        wf_threshold = 0.01 if oos_years >= 2 else 0.05
        step4 = _run_mcpt_stage('walk_forward_mcpt', _wf_mcpt_worker,
                                [seed + WF_SEED_OFFSET + i for i in range(mcpt_n_wf)], real_oos_obj,
                                mcpt_n_wf, threshold=wf_threshold, tick_units=n_eff_folds)

        # ── Benchmark overlays (one per benchmark) + legacy gates on the real WF arrays ──
        strat_returns = np.asarray(wf.net_returns, dtype=float)
        overlays: list[dict] = []
        for bt in (benchmark_tickers or list(bench_map.keys())):
            bs = bench_map.get(bt)
            if bs is None or not bs.close:
                continue
            br = np.asarray(series_period_returns(bs, wf.period_bounds), dtype=float)
            overlays.append(
                benchmark_overlay(strat_returns, br, benchmark=bt, periods_per_year=ppy).as_dict()
            )
        legacy = validate_strategy(
            ic_series=np.asarray(wf.ic_series, dtype=float),
            oos_returns=np.asarray(wf.net_returns, dtype=float),
            is_sharpe=float(np.mean([f['oos_objective'] for f in wf.per_fold])) if wf.per_fold else 0.0,
            n_trials=max(2, len(grid)),
            regime_series=np.array(['oos'] * len(wf.net_returns)),  # single bucket; MCPT is the gate
            covariance_matrix=None,
            pbo_returns_matrix=None,                                 # superseded by WF-MCPT here
            periods_per_year=ppy,
        )

        failures = list(legacy.failures)
        if not step2.passed:
            failures.append(f'In-sample MCPT quasi-p {step2.quasi_p:.3f} ≥ 0.01'
                            + (' (early-stopped — decision locked)' if step2.early_stopped else ''))
        if not step4.passed:
            failures.append(f'Walk-forward MCPT quasi-p {step4.quasi_p:.3f} ≥ {wf_threshold} (OOS {oos_years:.1f}y)'
                            + (' (early-stopped — decision locked)' if step4.early_stopped else ''))

        report = ValidationReportV2(
            strategy_id=strategy_id, objective_name=objective_name, engine='replay_mcpt',
            data_window_ms=[start_ms, end_ms], train_window_ms=[start_ms, train_ms],
            universe_size_at_run=len(panel.tickers),
            data_source=data_source or 'eodhd_daily',
            rebalance_days=rebalance_days,
            step1_in_sample_fit=asdict(step1), step2_in_sample_mcpt=asdict(step2),
            step3_walk_forward=asdict(step3), step4_walk_forward_mcpt=asdict(step4),
            benchmark_overlays=overlays, legacy_gates=_legacy_dict(legacy), data_quality=data_quality,
            permutation_seed={'engine': 'MT19937', 'base': seed, 'wf_offset': WF_SEED_OFFSET,
                              'n_in_sample': mcpt_n_in_sample, 'n_wf': mcpt_n_wf},
            passed=len(failures) == 0, failures=failures,
            context_notes=[
                'MCPT is the primary overfitting gate; legacy PBO is left uninformative (0.5).',
                'Regime breakdown collapsed to one bucket in the validator (MCPT supersedes it).',
                f'Universe = {len(panel.tickers)}-name aligned panel ({universe_kind}).',
            ],
        )
        return _sanitize(asdict(report))

    def _insufficient(self, strategy_id, objective_name, start_ms, end_ms, data_source, reason) -> dict:
        return _sanitize(asdict(ValidationReportV2(
            strategy_id=strategy_id, objective_name=objective_name, engine='replay_mcpt',
            data_window_ms=[start_ms, end_ms], train_window_ms=[start_ms, end_ms],
            universe_size_at_run=0, data_source=data_source, rebalance_days=0,
            step1_in_sample_fit={}, step2_in_sample_mcpt={}, step3_walk_forward={},
            step4_walk_forward_mcpt={}, benchmark_overlays=[], legacy_gates={}, data_quality='',
            passed=False, failures=[f'insufficient_history: {reason}'],
        )))


def _legacy_dict(report) -> dict:
    return {
        'mean_ic': report.mean_ic, 'ic_pvalue': report.ic_pvalue, 'ic_hit_rate': report.ic_hit_rate,
        'oos_sharpe': report.oos_sharpe, 'max_drawdown': report.max_drawdown, 'cvar_95': report.cvar_95,
        'deflated_sharpe': report.deflated_sharpe, 'pbo': report.pbo,
        'fdr_corrected_pvalue': report.fdr_corrected_pvalue, 'passed': report.passed,
        'failures': report.failures,
    }
