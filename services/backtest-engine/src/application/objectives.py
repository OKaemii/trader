"""Objective functions the validator optimises and the MCPT samples its null over.

All are `(OosPath) -> float`, **higher is better**, and **always finite** (a non-finite
objective would silently corrupt the quasi-p count and the JSON response). `profit_factor` is
the Masters default; the others let an operator pick the lens the strategy is judged through.
"""
from __future__ import annotations

from typing import Callable

import numpy as np

from .metrics import sharpe_ratio
from .replay_pnl import OosPath

Objective = Callable[[OosPath], float]


def profit_factor(path: OosPath) -> float:
    r = np.asarray(path.net_returns, dtype=float)
    if r.size == 0:
        return 0.0
    gains = float(r[r > 0].sum())
    losses = float(-r[r < 0].sum())
    # eps-guard: a path with no losing periods is "infinitely" profitable — cap it to a large
    # finite number so it stays JSON-safe and comparably ordered against permutations.
    return gains / max(losses, 1e-9)


def cum_return(path: OosPath) -> float:
    r = np.asarray(path.net_returns, dtype=float)
    return float(np.prod(1.0 + r) - 1.0) if r.size else 0.0


def ic_mean(path: OosPath) -> float:
    ic = np.asarray(path.ic_series, dtype=float)
    return float(ic.mean()) if ic.size else 0.0


def make_sharpe(periods_per_year: int) -> Objective:
    def _sharpe(path: OosPath) -> float:
        r = np.asarray(path.net_returns, dtype=float)
        return sharpe_ratio(r, periods_per_year) if r.size else 0.0
    return _sharpe


def make_objective(name: str, periods_per_year: int = 52) -> Objective:
    """ObjectiveFactory: name → callable. Defaults to profit_factor (Masters' recommendation)."""
    key = (name or 'profit_factor').lower()
    if key == 'profit_factor':
        return profit_factor
    if key == 'sharpe':
        return make_sharpe(periods_per_year)
    if key == 'cum_return':
        return cum_return
    if key == 'ic_mean':
        return ic_mean
    raise ValueError(
        f"unknown objective: {name!r} (known: profit_factor, sharpe, cum_return, ic_mean)"
    )
