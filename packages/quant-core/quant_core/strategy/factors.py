"""Factors as a GoF Composite — the answer to "overriding or composite?" → Composite.

A `Factor` is an interface (Protocol). Leaf factors (Momentum/Reversal/LowVol) and
`CompositeFactor` share that interface, so a composite is substitutable for a leaf (LSP) and
`factor_rank_v1` is literally `CompositeFactor([Momentum, Reversal, LowVol])` — equal weight
reproduces the legacy `(m+r+l)/3` exactly, and per-child weights are grid-searchable.

These leaves are used where the factor blend is a genuine equal-/weighted-mean of
independently z-scored factors (factor_rank). `sector_momentum_v1` and `topology_v1` z-score
at a different point in their pipelines, so they compose the `scorer` utilities directly
rather than forcing a shape that would break numerical parity — no inheritance, no overriding.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from .collaborators.scorer import eligible_returns, zscore
from .contract import HistoryView, StrategyParams

# ticker -> scalar score (z-scored, cross-sectional)
FactorScores = dict[str, float]


@runtime_checkable
class Factor(Protocol):
    name: str

    def score(self, history: HistoryView, window: int, params: StrategyParams) -> FactorScores:
        ...


class MomentumFactor:
    name = "momentum"

    def score(self, history, window, params) -> FactorScores:
        tickers, rets = eligible_returns(history, window)          # rets: (n_tickers, T)
        if not tickers:
            return {}
        # Cross-sectional momentum over a real horizon: cumulative return over the `lookback`
        # window ending `skip` bars ago. Default 12-1 (252 lookback, 21 skip) — skipping the
        # most recent month avoids the short-term-reversal contamination that made the legacy
        # full-`window` momentum (≈20d) anti-correlate with itself. Empty/flat slice → zeros.
        lookback = int(params.get("mom_lookback", 252))
        skip = int(params.get("mom_skip", 21))
        end = max(0, rets.shape[1] - max(0, skip))
        start = max(0, end - max(1, lookback))
        z = zscore(rets[:, start:end].sum(axis=1))
        return {t: float(z[i]) for i, t in enumerate(tickers)}


class ReversalFactor:
    name = "reversal"

    def score(self, history, window, params) -> FactorScores:
        tickers, rets = eligible_returns(history, window)
        if not tickers:
            return {}
        z = zscore(-rets[:, -1])  # short-term mean reversion: -last return
        return {t: float(z[i]) for i, t in enumerate(tickers)}


class LowVolFactor:
    name = "low_vol"

    def score(self, history, window, params) -> FactorScores:
        tickers, rets = eligible_returns(history, window)
        if not tickers:
            return {}
        z = zscore(-rets.std(axis=1))  # prefer low realised vol
        return {t: float(z[i]) for i, t in enumerate(tickers)}


class CompositeFactor:
    """A Factor that combines child Factors by weighted sum, aligned on common tickers.

    Default (no weights, empty params) = equal-weight MEAN, matching the legacy
    `(momentum + reversal + low_vol) / 3` so the refactor is rank- and value-preserving.
    Per-child weights are grid-searchable via params key `w_<child.name>`.
    """
    name = "composite"

    def __init__(self, children: list[Factor], weights: Optional[dict[str, float]] = None) -> None:
        self._children = list(children)
        self._weights = weights or {}

    @property
    def children(self) -> list[Factor]:
        return self._children

    def _weight(self, child: Factor, params: StrategyParams) -> float:
        default = self._weights.get(child.name, 1.0 / len(self._children))
        return params.get(f"w_{child.name}", default)

    def _child_scores(self, history, window, params) -> list[tuple[Factor, FactorScores]]:
        return [(c, c.score(history, window, params)) for c in self._children]

    def _common(self, child_scores) -> set[str]:
        common: Optional[set[str]] = None
        for _, s in child_scores:
            ks = set(s.keys())
            common = ks if common is None else (common & ks)
        return common or set()

    def score(self, history, window, params) -> FactorScores:
        cs = self._child_scores(history, window, params)
        common = self._common(cs)
        out: FactorScores = {}
        for t in common:
            out[t] = sum(self._weight(c, params) * s[t] for c, s in cs)
        return out

    def breakdown(self, history, window, params) -> dict[str, dict[str, float]]:
        """Per-ticker {child_name: z-score, ..., 'composite': total} — for attributions."""
        cs = self._child_scores(history, window, params)
        common = self._common(cs)
        out: dict[str, dict[str, float]] = {}
        for t in common:
            row = {c.name: s[t] for c, s in cs}
            row["composite"] = sum(self._weight(c, params) * s[t] for c, s in cs)
            out[t] = row
        return out
