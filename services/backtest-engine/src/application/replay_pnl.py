"""Turn a replay's per-rebalance target weights into a realised OOS path.

`Replay` (quant-core) emits *what to hold* at each rebalance instant; this module computes
*what that earned* — net-of-cost returns, gross returns, and the per-period information
coefficient — using the adjusted daily closes the same reader served. Kept free of any
quant-core / numpy-heavy import (it duck-types the replay step and uses pure Python +
scipy.spearmanr) so the realisation logic is unit-testable with hand-built fixtures.

No-lookahead: the weights chosen at period *k* (computed from closes ≤ t0) earn the forward
return over (t0, t1]. The final rebalance has no forward window and contributes nothing.
"""
from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from typing import Optional, Protocol


class _Step(Protocol):
    observation_ts: int
    target_weights: dict[str, float]
    output: object  # has .composite_scores: dict[str, float]


@dataclass
class PriceSeries:
    """Sorted (ts_ms, adjusted_close). `asof` returns the last close known at or before t."""
    ts: list[int]
    close: list[float]

    @classmethod
    def from_bars(cls, bars) -> "PriceSeries":
        ordered = sorted(bars, key=lambda b: b.timestamp)
        return cls(ts=[b.timestamp for b in ordered], close=[b.close for b in ordered])

    def asof(self, t: int) -> Optional[float]:
        i = bisect.bisect_right(self.ts, t) - 1
        return self.close[i] if i >= 0 else None


def forward_return(series: PriceSeries, t0: int, t1: int) -> Optional[float]:
    p0 = series.asof(t0)
    p1 = series.asof(t1)
    if p0 is None or p1 is None or p0 <= 0:
        return None
    return p1 / p0 - 1.0


@dataclass
class OosPath:
    net_returns: list[float] = field(default_factory=list)
    gross_returns: list[float] = field(default_factory=list)
    ic_series: list[float] = field(default_factory=list)
    period_bounds: list[tuple[int, int]] = field(default_factory=list)  # (t0, t1) per period


def _spearman(xs: list[float], ys: list[float]) -> Optional[float]:
    from scipy.stats import spearmanr
    rho, _ = spearmanr(xs, ys)
    return None if rho != rho else float(rho)  # rho != rho ⇒ NaN (constant input)


def realise(
    steps: list[_Step],
    prices: dict[str, PriceSeries],
    *,
    round_trip_bps: float = 12.0,
    min_ic_names: int = 5,
) -> OosPath:
    """Realise net/gross returns + IC over consecutive rebalances.

    `round_trip_bps` is charged per unit of one-way turnover (Σ|Δw|/2); the default 12 bps
    ≈ 2·(half-spread 5 + commission 1) from the assumed cost model. Pass a value derived from
    Phase-3 realised spreads (tca_log) when wiring that in.
    """
    path = OosPath()
    prev_w: dict[str, float] = {}
    for k in range(len(steps) - 1):
        s = steps[k]
        t0 = s.observation_ts
        t1 = steps[k + 1].observation_ts
        w = s.target_weights
        scores = getattr(s.output, "composite_scores", {}) or {}

        fwd: dict[str, float] = {}
        for tk in set(w) | set(scores):
            ps = prices.get(tk)
            if ps is None:
                continue
            r = forward_return(ps, t0, t1)
            if r is not None:
                fwd[tk] = r

        gross = sum(weight * fwd.get(tk, 0.0) for tk, weight in w.items())
        turnover = sum(
            abs(w.get(tk, 0.0) - prev_w.get(tk, 0.0)) for tk in set(w) | set(prev_w)
        ) / 2.0
        net = gross - turnover * round_trip_bps / 1e4

        path.gross_returns.append(gross)
        path.net_returns.append(net)
        path.period_bounds.append((t0, t1))

        common = [tk for tk in scores if tk in fwd]
        if len(common) >= min_ic_names:
            rho = _spearman([scores[tk] for tk in common], [fwd[tk] for tk in common])
            if rho is not None:
                path.ic_series.append(rho)

        prev_w = w
    return path


def series_period_returns(series: PriceSeries, bounds: list[tuple[int, int]]) -> list[float]:
    """Benchmark (or any single series) return over each (t0, t1] period; missing ⇒ 0.0.

    Aligned to the strategy's realised period bounds so the two return streams line up
    column-for-column for the benchmark overlay."""
    out: list[float] = []
    for t0, t1 in bounds:
        r = forward_return(series, t0, t1)
        out.append(r if r is not None else 0.0)
    return out
