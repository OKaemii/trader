"""Pure cross-sectional scoring utilities used BY factors. No I/O, no state."""
from __future__ import annotations

import numpy as np

from ..contract import HistoryView


def zscore(x: np.ndarray) -> np.ndarray:
    """Cross-sectional z-score; flat (all-zero) when dispersion is numerically negligible."""
    std = x.std()
    if std <= 1e-8:
        return np.zeros_like(x)
    return (x - x.mean()) / (std + 1e-8)


def nan_zscore(x: np.ndarray) -> np.ndarray:
    """Cross-sectional z-score that ignores NaN entries (NaN in → NaN out).

    Mean/std are computed only over the finite entries, so a name with a missing factor
    component never drags the cross-section toward a false 0 — it stays NaN and is excluded by
    the caller. Mirrors `zscore`'s flat-on-negligible-dispersion behaviour over the finite set.
    Returns all-NaN when fewer than two finite values are present (no dispersion to score on).
    """
    out = np.full(x.shape, np.nan, dtype=float)
    finite = np.isfinite(x)
    if finite.sum() < 2:
        return out
    vals = x[finite]
    std = vals.std()
    out[finite] = 0.0 if std <= 1e-8 else (vals - vals.mean()) / (std + 1e-8)
    return out


def eligible_returns(history: HistoryView, window: int) -> tuple[list[str], np.ndarray]:
    """Tickers with >= `window` closes and their (n_tickers, window-1) log-return matrix.

    Returns ([], empty) when fewer than 2 return columns are available — the caller treats
    that as "skip this cycle" (mirrors the legacy `returns.shape[1] < 2` guard).
    """
    tickers = sorted(t for t, c in history.closes.items() if len(c) >= window)
    if not tickers:
        return [], np.empty((0, 0))
    prices = np.array([history.closes[t][-window:] for t in tickers], dtype=float)
    rets = np.diff(np.log(prices), axis=1)
    if rets.shape[1] < 2:
        return [], np.empty((0, 0))
    return tickers, rets
