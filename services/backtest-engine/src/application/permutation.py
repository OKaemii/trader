"""Masters multi-market bar permutation — the surrogate price paths MCPT samples the null over.

Reference: Timothy Masters, *Permutation and Randomization Tests for Trading System
Development*. The permutation destroys the *time structure* a strategy could exploit while
preserving the statistical fingerprint of the market, so a strategy that scores no better on
permuted data than on real data has no real edge — that is the null.

What it preserves (all asserted in tests):
  - **First bar** of every ticker (rebuild starts at `start_index + 1`).
  - **Last close** of every ticker: `logC[-1] = logC[start] + Σ(gap_i + rc_i)`, and a permutation
    leaves both sums unchanged — so the close-to-close path is reshuffled but its endpoint holds.
  - **Cross-sectional correlation**: one shared permutation index is applied to *every* ticker,
    so the names that moved together on original bar *k* still move together on the bar that
    receives *k*'s relatives. This is what the rank strategies actually trade on.
  - **Positivity**: all work is in log space → `exp` is always > 0; no degenerate prices.

`start_index` keeps bars `≤ start_index` fixed (the in-sample/training fold in WF-MCPT) and only
permutes the tail — so a walk-forward permutation leaves the fitted region intact and shuffles
only the out-of-sample future the strategy is being judged on.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from quant_core.types import OHLCVBar


@dataclass(frozen=True)
class AlignedPanel:
    """A fully-populated price panel on a single shared timestamp grid — the precondition for a
    cross-sectionally-coherent permutation (every ticker has a bar at every grid instant)."""
    timestamps: np.ndarray          # (T,) int ms, ascending
    tickers: list[str]
    ohlc: dict[str, np.ndarray]     # ticker -> (T, 4) float [open, high, low, close]
    volume: dict[str, np.ndarray]   # ticker -> (T,) float


def align_panel(
    series: dict[str, list[OHLCVBar]],
    *,
    min_coverage: float = 0.8,
    min_bars: int = 30,
) -> AlignedPanel:
    """Reduce a ragged dict of OHLCV series to a rectangular panel on a common timestamp grid.

    A shared permutation index is only meaningful if every included ticker has a bar at every
    grid instant, so we (1) drop tickers covering < `min_coverage` of the richest series (late
    listings), then (2) intersect the survivors' timestamps. Tickers with any non-positive price
    are dropped (log space). Returns an empty panel (tickers=[]) when nothing usable remains —
    the caller turns that into an honest insufficient-data result, never a fabricated pass.
    """
    ts_sets = {t: {b.timestamp for b in bars} for t, bars in series.items() if bars}
    if not ts_sets:
        return AlignedPanel(np.empty(0, dtype=np.int64), [], {}, {})

    max_len = max(len(s) for s in ts_sets.values())
    kept = [t for t, s in ts_sets.items() if len(s) >= min_coverage * max_len]
    if not kept:
        return AlignedPanel(np.empty(0, dtype=np.int64), [], {}, {})

    grid_set = set.intersection(*(ts_sets[t] for t in kept))
    grid = np.array(sorted(grid_set), dtype=np.int64)
    if len(grid) < min_bars:
        return AlignedPanel(np.empty(0, dtype=np.int64), [], {}, {})

    ohlc: dict[str, np.ndarray] = {}
    volume: dict[str, np.ndarray] = {}
    final_tickers: list[str] = []
    for t in kept:
        by_ts = {b.timestamp: b for b in series[t]}
        arr = np.array([[by_ts[ts].open, by_ts[ts].high, by_ts[ts].low, by_ts[ts].close]
                        for ts in grid], dtype=float)
        if not np.all(np.isfinite(arr)) or np.any(arr <= 0):
            continue  # log space requires strictly-positive, finite OHLC
        ohlc[t] = arr
        volume[t] = np.array([by_ts[ts].volume for ts in grid], dtype=float)
        final_tickers.append(t)

    return AlignedPanel(grid, final_tickers, ohlc, volume)


def permute_panel(panel: AlignedPanel, start_index: int, seed: int) -> AlignedPanel:
    """One Masters permutation of a panel. MT19937(seed) → fully deterministic & recorded."""
    T = len(panel.timestamps)
    if T < 3 or start_index >= T - 2:
        return panel  # nothing to permute; the fixed region is the whole series

    rng = np.random.Generator(np.random.MT19937(seed))
    n = T - 1 - start_index
    perm_intra = rng.permutation(n)   # one shared shuffle across ALL tickers (cross-sec corr)
    perm_gap = rng.permutation(n)

    seg = np.arange(start_index + 1, T)          # bar indices whose intrabar relatives move
    gseg = np.arange(start_index, T - 1)         # gap indices entering bars start_index+1..T-1

    new_ohlc: dict[str, np.ndarray] = {}
    for t in panel.tickers:
        logp = np.log(panel.ohlc[t])             # (T,4): O H L C
        logO, logH, logL, logC = logp[:, 0], logp[:, 1], logp[:, 2], logp[:, 3]
        rh, rl, rc = logH - logO, logL - logO, logC - logO    # intrabar relatives (vs open)
        gaps = logO[1:] - logC[:-1]              # (T-1,) open_i − close_{i-1}

        new_rh, new_rl, new_rc = rh.copy(), rl.copy(), rc.copy()
        src = seg[perm_intra]
        new_rh[seg], new_rl[seg], new_rc[seg] = rh[src], rl[src], rc[src]
        new_gaps = gaps.copy()
        new_gaps[gseg] = gaps[gseg[perm_gap]]

        # Rebuild forward (vectorised): logC telescopes as a cumulative sum of (gap_i + rc_i),
        # then open = prior close + gap, and high/low hang off the new open via the relatives.
        nlogO, nlogH, nlogL, nlogC = logO.copy(), logH.copy(), logL.copy(), logC.copy()
        i_idx = np.arange(start_index + 1, T)
        d = new_gaps[i_idx - 1] + new_rc[i_idx]
        nlogC[start_index + 1:] = logC[start_index] + np.cumsum(d)
        nlogO[start_index + 1:] = nlogC[start_index:T - 1] + new_gaps[start_index:T - 1]
        nlogH[start_index + 1:] = nlogO[start_index + 1:] + new_rh[start_index + 1:]
        nlogL[start_index + 1:] = nlogO[start_index + 1:] + new_rl[start_index + 1:]

        new_ohlc[t] = np.exp(np.stack([nlogO, nlogH, nlogL, nlogC], axis=1))

    return AlignedPanel(panel.timestamps, list(panel.tickers), new_ohlc, dict(panel.volume))


def panel_to_bars(panel: AlignedPanel) -> dict[str, list[OHLCVBar]]:
    """Back to the quant-core native shape so an InMemoryBarsReader can drive a Replay."""
    out: dict[str, list[OHLCVBar]] = {}
    ts = panel.timestamps
    for t in panel.tickers:
        arr = panel.ohlc[t]
        vol = panel.volume[t]
        out[t] = [
            OHLCVBar(
                ticker=t, timestamp=int(ts[i]),
                open=float(arr[i, 0]), high=float(arr[i, 1]),
                low=float(arr[i, 2]), close=float(arr[i, 3]),
                volume=float(vol[i]),
            )
            for i in range(len(ts))
        ]
    return out


def permute_bars(
    series: dict[str, list[OHLCVBar]],
    start_index: int = 0,
    seed: int = 0,
    *,
    min_coverage: float = 0.8,
) -> dict[str, list[OHLCVBar]]:
    """align → permute → back to bars. The plan's entry point; the validator calls this."""
    return panel_to_bars(permute_panel(align_panel(series, min_coverage=min_coverage), start_index, seed))
