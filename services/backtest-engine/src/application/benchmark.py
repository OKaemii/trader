"""Benchmark overlay — strategy OOS path vs a passive benchmark over the same timeline.

A walk-forward Sharpe in isolation can look healthy while still trailing buy-and-hold. The
overlay answers the question an operator actually asks before flipping the live gate: *does
this beat just holding the index, after costs?* Inputs are two return series aligned on the
same rebalance periods (the orchestrator builds the benchmark series with the identical
forward-return computation it uses for the strategy's own names, so columns line up).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class BenchmarkComparison:
    benchmark: str
    periods: int
    strategy_total_return: float
    benchmark_total_return: float
    excess_total_return: float          # strategy − benchmark, cumulative
    alpha_annual: float                 # CAPM intercept, annualised
    beta: float                         # cov(strat, bench) / var(bench)
    information_ratio: float            # annualised mean(excess) / std(excess)
    beats_market: bool                  # strategy cumulative > benchmark cumulative
    strategy_equity: list[float]        # cumulative growth of £1
    benchmark_equity: list[float]

    def as_dict(self) -> dict:
        return {
            'benchmark': self.benchmark,
            'periods': self.periods,
            'strategy_total_return': self.strategy_total_return,
            'benchmark_total_return': self.benchmark_total_return,
            'excess_total_return': self.excess_total_return,
            'alpha_annual': self.alpha_annual,
            'beta': self.beta,
            'information_ratio': self.information_ratio,
            'beats_market': self.beats_market,
        }


def benchmark_overlay(
    strategy_returns: np.ndarray,
    benchmark_returns: np.ndarray,
    benchmark: str = '^GSPC',
    periods_per_year: int = 52,
) -> BenchmarkComparison:
    """CAPM α/β + information ratio + cumulative comparison.

    `periods_per_year` annualises α and the IR — 52 for weekly rebalancing, 252 for daily.
    Both inputs are per-period simple returns of equal length; mismatched lengths are
    truncated to the shorter (defensive — the orchestrator already aligns them).
    """
    s = np.asarray(strategy_returns, dtype=float).ravel()
    b = np.asarray(benchmark_returns, dtype=float).ravel()
    n = min(len(s), len(b))
    s, b = s[:n], b[:n]

    strat_equity = np.cumprod(1.0 + s) if n else np.array([1.0])
    bench_equity = np.cumprod(1.0 + b) if n else np.array([1.0])
    strat_total = float(strat_equity[-1] - 1.0) if n else 0.0
    bench_total = float(bench_equity[-1] - 1.0) if n else 0.0

    # β = cov/var; α = mean(strat) − β·mean(bench), annualised by periods_per_year.
    if n >= 2 and b.std() > 0:
        beta = float(np.cov(s, b, ddof=1)[0, 1] / np.var(b, ddof=1))
    else:
        beta = 0.0
    alpha_per_period = (float(s.mean()) - beta * float(b.mean())) if n else 0.0
    alpha_annual = alpha_per_period * periods_per_year

    excess = s - b
    if n >= 2 and excess.std(ddof=1) > 0:
        information_ratio = float(excess.mean() / excess.std(ddof=1) * np.sqrt(periods_per_year))
    else:
        information_ratio = 0.0

    return BenchmarkComparison(
        benchmark=benchmark,
        periods=n,
        strategy_total_return=strat_total,
        benchmark_total_return=bench_total,
        excess_total_return=strat_total - bench_total,
        alpha_annual=alpha_annual,
        beta=beta,
        information_ratio=information_ratio,
        beats_market=strat_total > bench_total,
        strategy_equity=[float(x) for x in strat_equity],
        benchmark_equity=[float(x) for x in bench_equity],
    )
