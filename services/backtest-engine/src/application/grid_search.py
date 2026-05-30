"""Grid search over a strategy's parameter_space via Replay — the one in-sample fit used by
both the Phase-4 walk-forward backtest and the Phase-5 validator (IS fit + every MCPT re-fit).

A "fit" is: run the strategy at each grid point over [lo, hi), realise the path, score it with
the chosen objective, keep the best. The objective is injected (`(OosPath) -> float`, higher
better) so the same sweep serves Sharpe (backtest) or profit_factor/cum_return/ic_mean (MCPT).
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Callable

from .replay_pnl import OosPath, realise

Objective = Callable[[OosPath], float]


def expand_grid(space: dict[str, list[float]]) -> list[dict[str, float]]:
    """Cartesian product of a discrete hyper-parameter grid → list of param dicts. {} → [{}]."""
    if not space:
        return [{}]
    keys = list(space.keys())
    return [dict(zip(keys, combo)) for combo in itertools.product(*(space[k] for k in keys))]


@dataclass
class GridResult:
    best_params: dict
    best_objective: float
    all_results: list[dict] = field(default_factory=list)   # [{params, objective}] for the heatmap


async def replay_path(strategy_id, reader, prices, params, lo, hi, step, universe_at, round_trip_bps):
    """One replay over [lo, hi) at `params` → realised OosPath. Fresh strategy each call (no
    cross-run state bleed); the reader is shared (warm cache / in-memory panel — no re-fetch)."""
    from quant_core.strategy.contract import StrategyParams
    from quant_core.wiring import build_replay

    replay = build_replay(strategy_id, bars=reader)
    res = await replay.run(
        lo, hi, step, universe_at, params=StrategyParams(values=params), write_features=False
    )
    return realise(res.steps, prices, round_trip_bps=round_trip_bps)


async def grid_search(
    strategy_id, reader, prices, grid, lo, hi, step, universe_at, objective: Objective, round_trip_bps,
) -> GridResult:
    """Sweep `grid` (list of param dicts) over [lo, hi); return the best by `objective`.

    A grid point whose realised path is too thin to score (< 2 periods) is recorded with
    objective=None and skipped for selection. If none scored, best_objective degrades to 0.0
    with the first grid point — the caller still gets a usable (if uninformative) fit."""
    points = grid or [{}]
    best_params: dict = points[0]
    best_obj = float('-inf')
    all_results: list[dict] = []
    for params in points:
        path = await replay_path(
            strategy_id, reader, prices, params, lo, hi, step, universe_at, round_trip_bps
        )
        if len(path.net_returns) < 2:
            all_results.append({'params': params, 'objective': None})
            continue
        obj = objective(path)
        all_results.append({'params': params, 'objective': obj})
        if obj > best_obj:
            best_obj, best_params = obj, params
    return GridResult(
        best_params=best_params,
        best_objective=best_obj if best_obj > float('-inf') else 0.0,
        all_results=all_results,
    )


def _equity(returns: list[float]) -> list[float]:
    if not returns:
        return []
    import numpy as np
    return [float(x) for x in np.cumprod(1.0 + np.asarray(returns, dtype=float))]


@dataclass
class WalkForwardOos:
    net_returns: list[float] = field(default_factory=list)
    ic_series: list[float] = field(default_factory=list)
    period_bounds: list = field(default_factory=list)
    per_fold: list[dict] = field(default_factory=list)


async def walk_forward_oos(
    strategy_id, reader, prices, grid, folds, step, universe_at, objective: Objective, round_trip_bps,
) -> WalkForwardOos:
    """Anchored walk-forward: per fold, grid-search IS on `objective` → best params → OOS replay;
    concatenate the OOS legs. Used for the real walk-forward (step 3) and, run on each permuted
    panel, for WF-MCPT (step 4) — so the surrogate sees the identical fit→evaluate process."""
    out = WalkForwardOos()
    for f in folds:
        gs = await grid_search(
            strategy_id, reader, prices, grid, f.train_start, f.train_end, step, universe_at,
            objective, round_trip_bps,
        )
        oos = await replay_path(
            strategy_id, reader, prices, gs.best_params, f.test_start, f.test_end, step,
            universe_at, round_trip_bps,
        )
        out.net_returns.extend(oos.net_returns)
        out.ic_series.extend(oos.ic_series)
        out.period_bounds.extend(oos.period_bounds)
        out.per_fold.append({
            'train_range_ms': [f.train_start, f.train_end],
            'test_range_ms': [f.test_start, f.test_end],
            'params': gs.best_params,
            'oos_objective': objective(oos),
            'oos_equity': _equity(oos.net_returns),
        })
    return out
