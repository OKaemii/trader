"""TrendFilter — absolute-momentum defensive overlay (composition, NOT a Factor).

It gates membership (drops names in a downtrend) and scales gross exposure when market breadth
is weak — it does NOT produce a cross-sectional rank, so it deliberately does not implement the
Factor protocol (LSP: don't make it substitutable for something it isn't). FactorRankStrategy
holds one and applies it after the composite scores are computed.

Pure price, no fundamentals, no look-ahead:
  - absolute momentum = trailing total return over `abs_lookback` bars; a name qualifies if
    that exceeds `abs_threshold` (default 0 ⇒ "only hold names in an uptrend");
  - breadth = qualifying fraction of the scored universe; when it falls below `breadth_floor`,
    gross exposure scales to `trend_risk_off_mult` (0.0 = fully to cash) so the book de-risks
    in broad downtrends.

This is the dimension the bar-permutation test cannot manufacture by shuffling (it exploits
serial trend persistence, which the shuffle destroys), and the cure for "profit = market beta".
"""
from __future__ import annotations

from ..contract import HistoryView, StrategyParams


class TrendFilter:
    name = "trend_filter"

    def apply(
        self, scores: dict[str, float], history: HistoryView, params: StrategyParams,
    ) -> tuple[dict[str, float], float, dict[str, float]]:
        lookback = int(params.get("abs_lookback", 252))
        threshold = float(params.get("abs_threshold", 0.0))
        risk_off = float(params.get("trend_risk_off_mult", 0.0))
        breadth_floor = float(params.get("breadth_floor", 0.4))

        abs_mom: dict[str, float] = {}
        for t in scores:
            c = history.closes.get(t, [])
            if len(c) > lookback and c[-1 - lookback] > 0:
                abs_mom[t] = c[-1] / c[-1 - lookback] - 1.0
            else:
                abs_mom[t] = 0.0  # insufficient history ⇒ treat as non-qualifying at threshold≥0

        qualifying = {t: s for t, s in scores.items() if abs_mom[t] > threshold}
        breadth = (len(qualifying) / len(scores)) if scores else 0.0
        exposure = 1.0 if breadth >= breadth_floor else risk_off
        return qualifying, exposure, {"breadth": breadth, "n_qualifying": float(len(qualifying))}
