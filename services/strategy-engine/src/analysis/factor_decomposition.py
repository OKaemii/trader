#!/usr/bin/env python3
"""
Fama-MacBeth factor decomposition for the trader strategy engine.

Measures residual alpha of a strategy after removing four factor premia:
  momentum (20-day), low-volatility, Amihud illiquidity, and log-size proxy.

Data sources (both from the live MongoDB cluster):
  signals     — TradeSignal documents (strategy_id, factor_exposures in rationale)
  ohlcv_bars  — raw bars for forward returns, Amihud, and size proxy

Method:
  1. Group signals by rebalance timestamp to get cross-sections.
  2. For each cross-section, cross-sectionally regress 5-day forward returns
     on factor z-scores (Fama-MacBeth step 1).
  3. Time-series mean and Newey-West t-stat of the per-period λ estimates
     (Fama-MacBeth step 2).
  4. Annualise the intercept (alpha) and check gates from tda-economic-rationale.md.

Minimum data: 40 rebalance periods (≈ 40 weeks).

Usage:
    MONGODB_URL=mongodb://trader:password@192.168.50.2:27017/trader \\
        python -m src.analysis.factor_decomposition

    # Override strategy or horizon:
    python -m src.analysis.factor_decomposition --strategy topology_v1 --horizon 5
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np
from scipy.stats import t as t_dist


# --------------------------------------------------------------------------- #
# MongoDB helpers (synchronous pymongo — standalone analysis script)
# --------------------------------------------------------------------------- #

def _get_db(mongo_url: str):
    try:
        from pymongo import MongoClient  # type: ignore
    except ImportError:
        print('[ERROR] pymongo not installed. Run: pip install pymongo==4.7.0')
        sys.exit(1)
    client = MongoClient(mongo_url, serverSelectionTimeoutMS=5_000)
    try:
        client.server_info()
    except Exception as exc:
        print(f'[ERROR] Cannot reach MongoDB at {mongo_url}: {exc}')
        sys.exit(1)
    return client['trader']


# --------------------------------------------------------------------------- #
# Data loading
# --------------------------------------------------------------------------- #

def load_periods(db, strategy_id: str) -> dict[int, list[dict]]:
    """
    Load signals grouped by rebalance period (timestamp).

    Returns
    -------
    {timestamp_ms: [{ticker, momentum, low_vol, topology, target_weight}, ...]}
    """
    periods: dict[int, list[dict]] = defaultdict(list)

    for doc in db['signals'].find(
        {'strategy_id': strategy_id},
        {'ticker': 1, 'timestamp': 1, 'rationale': 1, 'targetWeight': 1},
    ).sort('timestamp', 1):
        try:
            rationale = json.loads(doc.get('rationale', '{}'))
            fe: dict[str, float] = rationale.get('factor_exposures', {})
            if 'momentum' not in fe:
                continue
            periods[doc['timestamp']].append({
                'ticker':        doc['ticker'],
                'momentum':      float(fe.get('momentum', 0.0)),
                'low_vol':       float(fe.get('low_vol', 0.0)),
                'topology':      float(fe.get('topology', 0.0)),
                'target_weight': float(doc.get('targetWeight', 0.0)),
            })
        except (json.JSONDecodeError, KeyError, TypeError):
            continue

    return dict(periods)


_DAY_MS = 24 * 60 * 60 * 1_000


def load_bars(db, tickers: list[str], ref_ts: int,
              lookback: int, forward: int) -> dict[str, list[dict]]:
    """
    Load OHLCV bars for the window [ref_ts - lookback*day, ref_ts + forward*day].
    Returns {ticker: [{'timestamp', 'close', 'volume'}, ...]} sorted ascending.
    """
    t_lo = ref_ts - lookback * _DAY_MS
    t_hi = ref_ts + forward * _DAY_MS

    result: dict[str, list[dict]] = defaultdict(list)
    for doc in db['ohlcv_bars'].find(
        {'ticker': {'$in': tickers},
         'timestamp': {'$gte': t_lo, '$lte': t_hi}},
        {'ticker': 1, 'timestamp': 1, 'close': 1, 'volume': 1},
    ).sort('timestamp', 1):
        result[doc['ticker']].append({
            'timestamp': doc['timestamp'],
            'close':     float(doc['close']),
            'volume':    float(doc['volume']),
        })

    return dict(result)


# --------------------------------------------------------------------------- #
# Per-asset feature computation
# --------------------------------------------------------------------------- #

def _forward_return(bars: list[dict], ref_ts: int, horizon: int) -> float | None:
    """Log-return from the bar at/just-after ref_ts to horizon days later."""
    ref_bar = next((b for b in bars if b['timestamp'] >= ref_ts), None)
    if ref_bar is None:
        return None

    target_ts = ref_bar['timestamp'] + horizon * _DAY_MS
    fwd_bar = min(
        (b for b in bars if b['timestamp'] > ref_bar['timestamp']),
        key=lambda b: abs(b['timestamp'] - target_ts),
        default=None,
    )
    if fwd_bar is None or ref_bar['close'] <= 0 or fwd_bar['close'] <= 0:
        return None

    return float(np.log(fwd_bar['close'] / ref_bar['close']))


def _amihud(bars: list[dict], ref_ts: int, window: int) -> float | None:
    """
    Amihud (2002) illiquidity ratio: mean(|ret| / dollar_volume).
    Higher = less liquid (low-liquidity stocks earn a premium).
    We negate so that a positive z-score = high liquidity (like low-vol).
    """
    t_lo = ref_ts - window * _DAY_MS
    wb = [b for b in bars if t_lo <= b['timestamp'] <= ref_ts]
    if len(wb) < 5:
        return None

    ratios: list[float] = []
    for i in range(1, len(wb)):
        c0, c1 = wb[i - 1]['close'], wb[i]['close']
        if c0 <= 0 or c1 <= 0:
            continue
        ret = abs(np.log(c1 / c0))
        dollar_vol = c1 * wb[i]['volume']
        if dollar_vol > 1e-8:
            ratios.append(ret / dollar_vol)

    return float(-np.mean(ratios)) if ratios else None   # negated → high = liquid


def _log_size(bars: list[dict], ref_ts: int, window: int) -> float | None:
    """
    log(mean_price × mean_volume) over lookback window — proxy for market cap.
    Trading 212 does not expose share count, so this approximates size rank.
    """
    t_lo = ref_ts - window * _DAY_MS
    wb = [b for b in bars if t_lo <= b['timestamp'] <= ref_ts]
    if len(wb) < 5:
        return None

    proxy = np.mean([b['close'] for b in wb]) * np.mean([b['volume'] for b in wb])
    return float(np.log(proxy)) if proxy > 0 else None


# --------------------------------------------------------------------------- #
# Fama-MacBeth engine
# --------------------------------------------------------------------------- #

def _zscore_col(X: np.ndarray, col: int) -> None:
    """In-place cross-sectional z-score of column col (avoids period-level scale bias)."""
    std = X[:, col].std()
    if std > 1e-8:
        X[:, col] = (X[:, col] - X[:, col].mean()) / std


def _ols(y: np.ndarray, X: np.ndarray) -> np.ndarray:
    """OLS coefficients via least squares. X must include a constant column."""
    beta, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    return beta


def _newey_west_se(gammas: np.ndarray, lags: int | None = None) -> np.ndarray:
    """
    Newey-West (1987) HAC standard errors for the time-series of FM estimates.

    Parameters
    ----------
    gammas : (T, K) — one row per cross-section
    lags   : Bartlett kernel bandwidth; None → automatic (Andrews 1991 rule)

    Returns
    -------
    (K,) standard errors of the time-series mean
    """
    T, K = gammas.shape
    if lags is None:
        lags = max(1, int(np.floor(4 * (T / 100) ** (2 / 9))))

    mu = gammas.mean(axis=0)
    d  = gammas - mu                  # (T, K) demeaned

    Omega = d.T @ d / T               # lag-0 autocovariance
    for j in range(1, lags + 1):
        w = 1.0 - j / (lags + 1)     # Bartlett weight
        G = d[j:].T @ d[:-j] / T
        Omega += w * (G + G.T)

    # SE of the mean = sqrt(diag(Omega / T))
    return np.sqrt(np.maximum(np.diag(Omega) / T, 0.0))


def run_fama_macbeth(periods: dict[int, list[dict]], db,
                     horizon: int, window: int) -> dict:
    """
    Execute Fama-MacBeth cross-sectional regression for each rebalance period.

    Factors: [intercept, momentum, low_vol, amihud_liquidity, log_size, topology]

    Returns a results dict consumed by print_report().
    """
    FACTOR_NAMES = ['alpha', 'momentum_20d', 'low_volatility',
                    'amihud_liquidity', 'log_size', 'topology']

    gammas_list: list[np.ndarray] = []
    n_dropped = 0

    for ref_ts in sorted(periods):
        assets = periods[ref_ts]
        tickers = [a['ticker'] for a in assets]

        ohlcv = load_bars(db, tickers, ref_ts, window, horizon + 7)

        rows_y: list[float] = []
        rows_X: list[list[float]] = []

        for a in assets:
            t    = a['ticker']
            bars = ohlcv.get(t, [])

            fwd  = _forward_return(bars, ref_ts, horizon)
            amh  = _amihud(bars, ref_ts, window)
            size = _log_size(bars, ref_ts, window)

            if fwd is None or amh is None or size is None:
                n_dropped += 1
                continue

            rows_y.append(fwd)
            rows_X.append([
                1.0,
                a['momentum'],
                a['low_vol'],
                amh,
                size,
                a['topology'],
            ])

        if len(rows_y) < 5:
            continue

        y = np.array(rows_y)
        X = np.array(rows_X)

        # Winsorise forward returns at 1st/99th percentile
        y = np.clip(y, *np.percentile(y, [1, 99]))

        # Z-score continuous regressors cross-sectionally so λ is dimensionless
        _zscore_col(X, 3)   # amihud
        _zscore_col(X, 4)   # log_size

        gamma = _ols(y, X)
        if not np.any(np.isnan(gamma)):
            gammas_list.append(gamma)

    T = len(gammas_list)
    if T < 10:
        return {
            'error': (
                f'Only {T} valid cross-sections (need ≥ 10). '
                f'{n_dropped} asset-periods had missing OHLCV bars. '
                'Ensure the platform has run in paper mode for at least 10 weeks '
                'before running this script.'
            )
        }

    gammas     = np.array(gammas_list)      # (T, K)
    mean_g     = gammas.mean(axis=0)
    se_g       = _newey_west_se(gammas)
    t_stats    = mean_g / (se_g + 1e-12)
    p_values   = 2 * (1 - t_dist.cdf(np.abs(t_stats), df=T - 1))

    ann = 252 / horizon                     # annualisation multiplier

    return {
        'factor_names':   FACTOR_NAMES,
        'mean_gammas':    mean_g,
        'se_gammas':      se_g,
        't_stats':        t_stats,
        'p_values':       p_values,
        'n_periods':      T,
        'n_dropped':      n_dropped,
        'horizon':        horizon,
        'ann_alpha':      float(mean_g[0] * ann),
        'ann_alpha_tstat': float(t_stats[0]),
        'ann_alpha_pval': float(p_values[0]),
    }


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #

_LABELS = {
    'alpha':             'Intercept (alpha):       ',
    'momentum_20d':      'Momentum (20-day):       ',
    'low_volatility':    'Low Volatility:          ',
    'amihud_liquidity':  'Liquidity (Amihud):      ',
    'log_size':          'Size (log proxy):        ',
    'topology':          'Topology residual:       ',
}


def print_report(results: dict, strategy_id: str) -> None:
    if 'error' in results:
        print(f'\n[ERROR] {results["error"]}')
        sys.exit(1)

    fn = results['factor_names']
    mg = results['mean_gammas']
    ts = results['t_stats']
    pv = results['p_values']
    T  = results['n_periods']
    h  = results['horizon']

    sep = '─' * 70
    print()
    print(f'Strategy: {strategy_id}')
    print(f'Horizon:  {h}-day forward return  (annualisation ×{252 // h})')
    print(f'Periods:  {T} rebalance cross-sections  '
          f'(Fama-MacBeth, Newey-West HAC SE)')
    print(f'Dropped:  {results["n_dropped"]} asset-periods (missing OHLCV)')
    print()
    print('Factor Attribution:')
    print()

    for i, name in enumerate(fn):
        label = _LABELS.get(name, name)
        sig   = '**' if pv[i] < 0.05 else ('*' if pv[i] < 0.10 else '  ')
        print(f'  {label}  β = {mg[i]:+.5f}   t = {ts[i]:+.3f}'
              f'   p = {pv[i]:.4f}  {sig}')

    print(f'  {sep}')
    ann_pct = results['ann_alpha'] * 100
    print(f'  Residual alpha (annual):  {ann_pct:+.2f} %')
    print(f'  Residual t-stat:          {results["ann_alpha_tstat"]:+.3f}')
    print(f'  Residual p-value:         {results["ann_alpha_pval"]:.4f}')
    print()

    alpha_pos  = results['ann_alpha'] > 0
    alpha_sig  = results['ann_alpha_pval'] < 0.10
    topo_idx   = fn.index('topology')
    topo_pass  = mg[topo_idx] > 0 and pv[topo_idx] < 0.10
    overall    = alpha_pos and alpha_sig

    print('Conclusion:')
    print(f'  Residual alpha > 0:           {"PASS" if alpha_pos else "FAIL"}')
    print(f'  p-value < 0.10:               {"PASS" if alpha_sig else "FAIL"}')
    print(f'  Topology λ positive & p<0.10: {"PASS" if topo_pass else "FAIL"}')
    print()
    if overall:
        print('  [x] PASS — residual alpha positive and p < 0.10')
        print('      Paste these results into tda-economic-rationale.md Section 4.')
    else:
        print('  [ ] FAIL — residual alpha does not meet threshold.')
        print('      Do not enable topology_v1 or TRADING_MODE=live.')
        print('      Investigate factor loadings and extend the OOS period.')
    print()
    print('** p < 0.05   * p < 0.10')


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Fama-MacBeth factor decomposition — validates topology_v1 edge'
    )
    parser.add_argument(
        '--strategy', default='topology_v1',
        help='strategy_id to analyse (default: topology_v1)',
    )
    parser.add_argument(
        '--horizon', type=int, default=5,
        help='Forward return horizon in trading days (default: 5)',
    )
    parser.add_argument(
        '--window', type=int, default=20,
        help='Lookback window for Amihud/size computation (default: 20)',
    )
    args = parser.parse_args()

    mongo_url = os.environ.get('MONGODB_URL', 'mongodb://localhost:27017')
    db = _get_db(mongo_url)

    print(f'[factor_decomposition] MongoDB connected.')
    print(f'  Strategy: {args.strategy}  |  Horizon: {args.horizon}d  '
          f'|  Window: {args.window}d')
    print('  Loading signals ...')

    periods = load_periods(db, args.strategy)

    if not periods:
        print(
            f'[ERROR] No signals found for strategy_id="{args.strategy}".\n'
            '  The platform must have run in paper mode (ACTIVE_STRATEGY set to\n'
            f'  "{args.strategy}") for at least 10 weeks before running this script.'
        )
        sys.exit(1)

    total_assets = sum(len(v) for v in periods.values())
    print(f'  {len(periods)} rebalance periods, {total_assets} total signal records.')
    print('  Running Fama-MacBeth regression ...')

    results = run_fama_macbeth(periods, db, args.horizon, args.window)
    print_report(results, args.strategy)


if __name__ == '__main__':
    main()
