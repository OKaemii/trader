"""Strategy-independent research factor set + cross-sectional percentiles.

`compute_research_factors` is the one computation the Research surface trusts for *any* symbol,
regardless of which strategy is live: it scores the full active universe on four factors —
``momentum``, ``quality``, ``value``, ``volatility`` — and returns, per ticker, each factor's raw
cross-sectional z-score plus a percentile rank in [0, 100].

Source-agnostic by construction. Price factors (momentum, volatility) read `HistoryView.closes`;
fundamentals factors (quality, value) read `HistoryView.fundamentals` ONLY — the same map the host
fills from the `FundamentalsAsOf` provider seam (§H). This function never knows whether those line
items came from today's Yahoo snapshot or a future point-in-time warehouse; it only ever sees the
`fundamentals` map. That keeps Research honest for every symbol without coupling it to a source.

Missing-factor invariant: a name without a finite value for a factor gets ``None`` for *that*
factor — never a 0. A 0 raw/pct would be a real, rankable score the Research UI (and the T9
`factor_store` that persists this verbatim) would mistake for "computed and middling", masking the
"no data" case. So a name absent from a factor's finite cross-section is emitted as
``{"raw": None, "pct": None}`` for that factor alone, while its other factors still carry values.

Return shape (stable — T9 persists it verbatim, one doc per ticker per cycle):

    {
      "AAPL_US_EQ": {
        "momentum":   {"raw": 1.83, "pct": 92.0},
        "quality":    {"raw": 0.70, "pct": 84.0},
        "value":      {"raw": -0.40, "pct": 31.0},
        "volatility": {"raw": -0.20, "pct": 61.0},
      },
      ...
    }
"""
from __future__ import annotations

from typing import Optional, TypedDict

import numpy as np

from .strategy.collaborators.scorer import eligible_returns
from .strategy.contract import HistoryView, StrategyParams
from .strategy.factors import QualityFactor, ValueFactor

# The four research factors, in a fixed order so every emitted row carries the same keys.
RESEARCH_FACTORS = ("momentum", "quality", "value", "volatility")


class FactorCell(TypedDict):
    """One factor for one ticker: the raw cross-sectional z-score + its percentile in [0,100].

    Both are ``None`` (never 0) when the name had no finite value for this factor.
    """
    raw: Optional[float]
    pct: Optional[float]


# Per-ticker map of every research factor to its cell. T9 persists this verbatim.
FactorRow = dict[str, FactorCell]


def _percentiles(values: np.ndarray) -> np.ndarray:
    """Percentile rank in [0,100] for each finite value; NaN passes through as NaN.

    Hazen / mean-rank definition over the finite cross-section: a value's percentile is the
    fraction of finite values below it plus half the fraction equal to it, scaled to 100. Ties
    share the same percentile (symmetric midrank), and a lone finite name maps to 50 — the
    cross-section's centre, which is the honest read with no dispersion to rank against.
    """
    out = np.full(values.shape, np.nan, dtype=float)
    finite = np.isfinite(values)
    n = int(finite.sum())
    if n == 0:
        return out
    vals = values[finite]
    # below[i] = #{strictly less}, equal[i] = #{equal} (incl. self) for each finite value.
    below = (vals[:, None] > vals[None, :]).sum(axis=1)
    equal = (vals[:, None] == vals[None, :]).sum(axis=1)
    out[finite] = 100.0 * (below + 0.5 * equal) / n
    return out


def _price_zscores(raw: np.ndarray) -> np.ndarray:
    """Cross-sectional z-score over the finite entries (NaN in → NaN out, like `nan_zscore`).

    Distinct from `scorer.zscore`, which zero-fills the whole vector when dispersion is
    negligible. Here a flat-but-finite cross-section z-scores to all-0.0 raws (real, rankable),
    but a sub-2 finite set has no dispersion to score on and stays NaN → those names emit None.
    """
    out = np.full(raw.shape, np.nan, dtype=float)
    finite = np.isfinite(raw)
    if finite.sum() < 2:
        return out
    vals = raw[finite]
    std = vals.std()
    out[finite] = 0.0 if std <= 1e-8 else (vals - vals.mean()) / (std + 1e-8)
    return out


def _price_factors(
    history: HistoryView, window: int
) -> tuple[dict[str, float], dict[str, float]]:
    """Raw (un-z-scored) momentum + volatility per ticker, computed from closes.

    Momentum mirrors `MomentumFactor`: cumulative log-return over a 12-1 window (252 lookback,
    21 skip) — but defaults are clamped to the available return columns so a short Research
    window still produces a signal (the live factor assumes a full 300-bar daily window).
    Volatility mirrors `LowVolFactor`'s sign convention: ``-realised stdev`` so that higher =
    *lower* vol, keeping the four factors "higher percentile is more desirable" consistent.
    """
    tickers, rets = eligible_returns(history, window)
    if not tickers:
        return {}, {}
    n_cols = rets.shape[1]
    lookback = min(252, n_cols)
    skip = 21 if n_cols > 21 else 0
    end = n_cols - skip
    start = max(0, end - lookback)
    momentum_raw = rets[:, start:end].sum(axis=1)
    volatility_raw = -rets.std(axis=1)  # higher = lower realised vol
    momentum = {t: float(momentum_raw[i]) for i, t in enumerate(tickers)}
    volatility = {t: float(volatility_raw[i]) for i, t in enumerate(tickers)}
    return momentum, volatility


def compute_research_factors(history: HistoryView, *, window: int) -> dict[str, FactorRow]:
    """Cross-sectional research factor set over the universe in `history`.

    For each of the four factors: z-score the names with a finite value, percentile-rank that
    z-score in [0,100], and emit ``{"raw": z, "pct": p}`` per name. A name missing the factor
    (short history for price factors; absent/zero-denominator fundamentals for quality/value)
    gets ``{"raw": None, "pct": None}`` for that factor alone — never a 0.

    Runs regardless of the active strategy: price factors need only `history.closes`,
    fundamentals factors read `history.fundamentals` only. The union of every name appearing in
    any factor's cross-section gets a row; each row always carries all four factor keys.
    """
    momentum_raw, volatility_raw = _price_factors(history, window)

    # Quality + Value reuse the Task 6 continuous factors verbatim — they already z-score each
    # component over the names that have it and drop missing-denominator names (no false 0). Their
    # output is the per-name composite z-score; we percentile-rank it cross-sectionally below.
    _p = StrategyParams(values={})
    quality_z = QualityFactor().score(history, window, _p)
    value_z = ValueFactor().score(history, window, _p)

    # Price factors arrive as raw scores → z-score them here (the fundamentals factors are already
    # z-scored, so they pass through as their own raw). Then percentile-rank every factor.
    factor_cells: dict[str, dict[str, FactorCell]] = {}
    raw_by_factor: dict[str, dict[str, float]] = {
        "momentum": momentum_raw,
        "volatility": volatility_raw,
        "quality": quality_z,
        "value": value_z,
    }
    needs_zscore = {"momentum", "volatility"}

    for factor in RESEARCH_FACTORS:
        raw_map = raw_by_factor[factor]
        names = sorted(raw_map.keys())
        if not names:
            factor_cells[factor] = {}
            continue
        raw_vec = np.array([raw_map[t] for t in names], dtype=float)
        z_vec = _price_zscores(raw_vec) if factor in needs_zscore else raw_vec
        pct_vec = _percentiles(z_vec)
        factor_cells[factor] = {
            t: FactorCell(raw=float(z_vec[i]), pct=float(pct_vec[i]))
            for i, t in enumerate(names)
            if np.isfinite(z_vec[i])
        }

    # Assemble one row per ticker over the union of names seen in any factor; a name absent from a
    # factor's finite set gets {"raw": None, "pct": None} for that factor (never 0).
    all_tickers: set[str] = set()
    for cells in factor_cells.values():
        all_tickers.update(cells.keys())

    rows: dict[str, FactorRow] = {}
    for ticker in sorted(all_tickers):
        rows[ticker] = {
            factor: factor_cells[factor].get(ticker, FactorCell(raw=None, pct=None))
            for factor in RESEARCH_FACTORS
        }
    return rows
