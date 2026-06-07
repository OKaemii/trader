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

import numpy as np

from .collaborators.scorer import eligible_returns, nan_zscore, zscore
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


# --- Fundamentals-driven factors -------------------------------------------------------------
#
# Quality and Value are *continuous, cross-sectional* fundamentals factors — distinct from the
# fail-closed QMJ boolean (`screen/quality.py`) that high_velocity_v1 uses as a hard gate. They
# read the per-ticker snapshot the host attaches via `HistoryView.fundamentals[t]` (snake_case
# raw line items, same shape `market_data_client.fetch_fundamentals` produces); the factor code
# is source-agnostic — it never knows whether the line items came from the Yahoo snapshot
# (today, forward-only) or a future point-in-time warehouse fed through the same `fundamentals`
# map. A component whose denominator is missing or non-positive yields NaN for that name, so the
# name is *excluded* from the cross-section for that component — never scored as a false 0.


def _safe_ratio(numerator: float, denominator: float) -> float:
    """numerator / denominator, or NaN when the denominator is missing/non-positive.

    Equity, revenue and market-cap denominators are economically meaningless at or below zero
    (a negative-equity firm's ROE/leverage, a no-revenue firm's margin), and dividing by them
    would manufacture a finite score from no real signal — so they collapse to NaN, which the
    z-score step drops rather than treating as a 0 the optimiser could rank on.
    """
    if denominator is None or not np.isfinite(denominator) or denominator <= 0:
        return float("nan")
    if numerator is None or not np.isfinite(numerator):
        return float("nan")
    return numerator / denominator


def _blend(components: list[np.ndarray]) -> np.ndarray:
    """Mean across already-z-scored component columns, ignoring NaN per name.

    A name keeps a finite blend as long as *any* component is finite (averaged over just the
    finite ones); a name with no finite component stays NaN. `np.nanmean` over an all-NaN row
    warns + returns NaN, so we guard the all-NaN rows explicitly to keep the output clean.
    """
    stacked = np.vstack(components)                      # (n_components, n_tickers)
    out = np.full(stacked.shape[1], np.nan, dtype=float)
    any_finite = np.isfinite(stacked).any(axis=0)
    if any_finite.any():
        out[any_finite] = np.nanmean(stacked[:, any_finite], axis=0)
    return out


def _fundamentals_factor(
    history: HistoryView, components: list[np.ndarray], tickers: list[str]
) -> FactorScores:
    """Blend pre-z-scored component columns and emit only the names with a finite blend."""
    blended = _blend(components)
    return {t: float(blended[i]) for i, t in enumerate(tickers) if np.isfinite(blended[i])}


class QualityFactor:
    """Continuous QMJ-style quality composite — higher is more profitable + better-capitalised.

    A cross-sectional z-score blend of four profitability/solvency signals, each computed from
    `HistoryView.fundamentals[t]` and z-scored independently over the names that have it:
      - ROE                 = net_income / total_equity
      - gross margin        = gross_profit / total_revenue
      - low leverage        = -(total_debt / total_equity)   (sign flipped: less debt scores higher)
      - earnings stability  = earnings_stability             (host-supplied; higher = steadier)
    Forward-only: with no point-in-time fundamentals source these come from the live snapshot, so
    historical reconstruction leaves them absent (the host writes the factor as None for past
    cycles). A missing/non-positive denominator → NaN for that component, and a name with no
    finite component is dropped from the result (never a false 0).
    """
    name = "quality"

    def score(self, history, window, params) -> FactorScores:
        tickers = sorted(history.fundamentals.keys())
        if not tickers:
            return {}
        f = [history.fundamentals.get(t, {}) for t in tickers]
        roe = np.array([_safe_ratio(d.get("net_income"), d.get("total_equity")) for d in f])
        margin = np.array([_safe_ratio(d.get("gross_profit"), d.get("total_revenue")) for d in f])
        leverage = np.array([-_safe_ratio(d.get("total_debt"), d.get("total_equity")) for d in f])
        stability = np.array(
            [float(d["earnings_stability"]) if "earnings_stability" in d else float("nan") for d in f]
        )
        components = [nan_zscore(roe), nan_zscore(margin), nan_zscore(leverage), nan_zscore(stability)]
        return _fundamentals_factor(history, components, tickers)


class ValueFactor:
    """Continuous value composite — higher = cheaper relative to fundamentals.

    A cross-sectional z-score blend of three yield/cheapness signals from
    `HistoryView.fundamentals[t]`, each z-scored over the names that have it:
      - dividend yield  = dividend_yield                  (host-supplied; EODHD Dividends is
                                                            point-in-time → this leg is backfillable)
      - earnings yield  = net_income / market_cap_gbp
      - book-to-market  = total_equity / market_cap_gbp
    The earnings/book legs come from the (forward-only) fundamentals snapshot; only the dividend
    leg has a point-in-time history (§H). A missing/non-positive denominator → NaN for that
    component; a name with no finite component is dropped (never a false 0).
    """
    name = "value"

    def score(self, history, window, params) -> FactorScores:
        tickers = sorted(history.fundamentals.keys())
        if not tickers:
            return {}
        f = [history.fundamentals.get(t, {}) for t in tickers]
        div_yield = np.array(
            [float(d["dividend_yield"]) if "dividend_yield" in d else float("nan") for d in f]
        )
        earnings_yield = np.array([_safe_ratio(d.get("net_income"), d.get("market_cap_gbp")) for d in f])
        book_to_market = np.array([_safe_ratio(d.get("total_equity"), d.get("market_cap_gbp")) for d in f])
        components = [nan_zscore(div_yield), nan_zscore(earnings_yield), nan_zscore(book_to_market)]
        return _fundamentals_factor(history, components, tickers)


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
