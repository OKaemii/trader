"""Annualised realised volatility per ticker — shared by high_velocity's vol-drop selection and
the inverse-vol weighting. Std of daily log-returns over the trailing `lookback` closes × √252.
Names with too little usable history get +inf so they sort last (dropped by the vol filter) and,
if they slip through, receive ~0 inverse-vol weight.
"""
from __future__ import annotations

import numpy as np

from ..contract import HistoryView

TRADING_DAYS = 252.0


def annualised_vol(history: HistoryView, tickers: list[str], lookback: int) -> dict[str, float]:
    out: dict[str, float] = {}
    for t in tickers:
        closes = history.closes.get(t, [])
        arr = np.asarray(closes[-(max(1, lookback) + 1):], dtype=float)
        arr = arr[np.isfinite(arr) & (arr > 0)]
        if arr.size < 3:
            out[t] = float("inf")
            continue
        rets = np.diff(np.log(arr))
        out[t] = float(np.std(rets) * np.sqrt(TRADING_DAYS))
    return out
