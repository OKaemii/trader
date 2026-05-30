"""Long-only optimiser — a faithful Python port of signal-service's `solveLongOnly`
(services/signal-service/src/modules/signals/application/LongOnlyOptimiser.ts).

Live sizing happens in signal-service (TypeScript); replay sizing happens here. Physics
forces two implementations (HTTP-per-permutation is infeasible), so this is the single
sanctioned cross-language duplication in the architecture — contained by the golden-vector
parity test (tests/test_long_only.py) which mirrors the TS test's exact cases.

Both runtimes use IEEE-754 float64 and the same operation order (V8 and CPython sorts are
both stable), so the port is bit-faithful for the same inputs.
"""
from __future__ import annotations

from ..types import StrategyOutput

# Mirror of RISK_LIMITS in the TS source (only the fields solveLongOnly uses).
MAX_SINGLE_NAME = 0.15
MAX_SECTOR_CONCENTRATION = 0.30
MAX_WEEKLY_TURNOVER = 0.20


def solve_long_only(
    scores: list[float],
    tickers: list[str],
    sectors: list[str],
    current_weights: list[float],
    top_k: int = 0,
) -> list[float]:
    n = len(tickers)

    # Step 1: positive composite scores only (no synthetic shorts).
    eligible = [(s, i) for i, s in enumerate(scores) if s > 0]
    if not eligible:
        return [0.0] * n

    # Step 1b: top-K truncation (stable sort desc by score; ties keep lower index, as V8).
    if top_k and top_k > 0 and len(eligible) > top_k:
        eligible = sorted(eligible, key=lambda x: -x[0])[:top_k]

    # Step 2: proportional weights, capped at maxSingleName.
    raw = [0.0] * n
    pos_score_sum = sum(s for s, _ in eligible)
    for s, i in eligible:
        raw[i] = min(s / pos_score_sum, MAX_SINGLE_NAME)

    # Step 3: sector neutrality — cap each sector at maxSectorConcentration.
    sector_totals: dict[str, float] = {}
    for i in range(n):
        sec = sectors[i] if i < len(sectors) and sectors[i] else 'UNKNOWN'
        sector_totals[sec] = sector_totals.get(sec, 0.0) + raw[i]
    for i in range(n):
        sec = sectors[i] if i < len(sectors) and sectors[i] else 'UNKNOWN'
        sector_total = sector_totals.get(sec, 0.0)
        if sector_total > MAX_SECTOR_CONCENTRATION:
            raw[i] = raw[i] * (MAX_SECTOR_CONCENTRATION / sector_total)

    # Step 4: re-normalise to sum = 1.
    total = sum(raw)
    normalised = [(w / total if total > 0 else 0.0) for w in raw]

    # Step 5: turnover guard — blend toward current weights if turnover exceeds budget.
    turnover = sum(
        abs(w - (current_weights[i] if i < len(current_weights) else 0.0))
        for i, w in enumerate(normalised)
    ) / 2
    if turnover > MAX_WEEKLY_TURNOVER:
        blend = MAX_WEEKLY_TURNOVER / turnover
        return [
            blend * w + (1 - blend) * (current_weights[i] if i < len(current_weights) else 0.0)
            for i, w in enumerate(normalised)
        ]

    return normalised


class LongOnlyOptimiser:
    """Adapts a StrategyOutput + current weights to `solve_long_only`. Implements `Optimiser`."""

    def weights(
        self, output: StrategyOutput, current_weights: dict[str, float]
    ) -> dict[str, float]:
        tickers = output.ticker_universe
        scores = [output.composite_scores.get(t, 0.0) for t in tickers]
        sectors = [output.sectors.get(t, 'UNKNOWN') for t in tickers]
        cw = [current_weights.get(t, 0.0) for t in tickers]
        w = solve_long_only(scores, tickers, sectors, cw, output.top_k or 0)
        return {t: w[i] for i, t in enumerate(tickers)}
