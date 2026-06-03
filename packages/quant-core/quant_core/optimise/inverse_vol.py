"""Inverse-volatility optimiser — w_i ∝ 1/σ_i over the strategy's emitted held set.

For strategies that emit a precomputed held set and declare weighting='inverse_vol'
(high_velocity_v1's ~20 survivors). Unlike solve_long_only it does NOT re-select or apply a
sector cap — the strategy already chose the names; this only sizes them by inverse vol (a
risk-parity-lite tilt toward calmer names) with a MONTHLY turnover budget (default 1.0 = full
rebalance allowed). Parity-tested against signal-service's InverseVolOptimiser.ts.
"""
from __future__ import annotations

import math

from ..types import StrategyOutput

MAX_MONTHLY_TURNOVER = 1.0


def solve_inverse_vol(
    volatilities: list[float],
    tickers: list[str],
    current_weights: list[float],
    max_turnover: float = MAX_MONTHLY_TURNOVER,
) -> list[float]:
    n = len(tickers)
    inv = [0.0] * n
    total = 0.0
    for i in range(n):
        v = volatilities[i] if i < len(volatilities) else 0.0
        if v is not None and math.isfinite(v) and v > 0:
            inv[i] = 1.0 / v
            total += inv[i]
    if total <= 0:
        return [0.0] * n
    raw = [w / total for w in inv]

    # Monthly turnover guard — at the default budget of 1.0 a full rebalance always passes
    # (turnover ≤ 1.0); set < 1.0 to throttle. Mirrors solve_long_only's blend-toward-current.
    turnover = sum(abs(raw[i] - (current_weights[i] if i < len(current_weights) else 0.0)) for i in range(n)) / 2
    if turnover > max_turnover:
        blend = max_turnover / turnover
        return [blend * raw[i] + (1 - blend) * (current_weights[i] if i < len(current_weights) else 0.0) for i in range(n)]
    return raw


class InverseVolOptimiser:
    """Adapts a StrategyOutput + current weights to solve_inverse_vol. Implements `Optimiser`.

    Reads per-ticker σ from factor_attributions[t]['volatility'] and weights ALL emitted names
    (the strategy already truncated to its held set — no re-selection / no sector cap here).
    """

    def weights(self, output: StrategyOutput, current_weights: dict[str, float]) -> dict[str, float]:
        tickers = output.ticker_universe
        vols = [float(output.factor_attributions.get(t, {}).get('volatility', 0.0)) for t in tickers]
        cw = [current_weights.get(t, 0.0) for t in tickers]
        w = solve_inverse_vol(vols, tickers, cw)
        return {t: w[i] for i, t in enumerate(tickers)}
