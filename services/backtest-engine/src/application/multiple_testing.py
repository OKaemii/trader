import numpy as np


def bh_corrected_pvalue(raw_pvalue: float, n_tests: int, fdr_level: float = 0.05) -> float:
    """BH-adjusted p-value for a single test; conservative (treats this as the worst-ranked test)."""
    return min(raw_pvalue * n_tests, 1.0)


def bh_procedure(pvalues: np.ndarray, fdr_level: float = 0.05) -> np.ndarray:
    """Full BH procedure over an array of p-values. Returns boolean mask: True = discovery survives FDR correction."""
    n = len(pvalues)
    ranked = np.argsort(pvalues)
    sorted_p = pvalues[ranked]
    thresholds = (np.arange(1, n + 1) / n) * fdr_level
    below = sorted_p <= thresholds
    if not below.any():
        return np.zeros(n, dtype=bool)
    cutoff = np.where(below)[0].max()
    result = np.zeros(n, dtype=bool)
    result[ranked[:cutoff + 1]] = True
    return result


def deflated_sharpe_ratio(sharpe: float, returns: np.ndarray, n_trials: int) -> float:
    """Bailey & Lopez de Prado (2014) Deflated Sharpe Ratio. Returns DSR; must be > 0 for a valid discovery."""
    from scipy import stats as scipy_stats
    T = len(returns)
    skew = float(scipy_stats.skew(returns))
    kurt = float(scipy_stats.kurtosis(returns))

    euler_gamma = 0.5772156649
    expected_max = (
        (1 - euler_gamma) * scipy_stats.norm.ppf(1 - 1 / n_trials)
        + euler_gamma * scipy_stats.norm.ppf(1 - 1 / (n_trials * np.e))
    )

    var_sharpe = (1 + (skew * sharpe) - ((kurt - 1) / 4) * sharpe**2) / T
    if var_sharpe <= 0:
        return 0.0

    dsr = scipy_stats.norm.cdf((sharpe - expected_max) / np.sqrt(var_sharpe))
    return float(dsr - 0.5)


def compute_pbo(returns_matrix: np.ndarray, n_partitions: int = 16) -> float:
    """Probability of Backtest Overfitting via CSCV (Bailey, Borwein, López de Prado, Zhu 2014).

    `returns_matrix`: (n_configs, n_periods). Returns PBO ∈ [0, 1]; ≥ 0.5 ⇒ likely overfit
    (the in-sample-best configuration is no better than a coin flip out-of-sample).

    CSCV partitions the timeline into ``S`` equal **contiguous blocks** (S even), then for
    every way to assign S/2 blocks to the in-sample set (the rest out-of-sample) it picks the
    IS-best config and asks whether that config lands below the OOS median across configs.
    PBO is the fraction of splits where it does.

    Why blocks, not the old ``combinations(range(T), T//2)``: choosing T/2 of T *individual*
    periods is C(T, T/2) — for a few hundred weekly periods that is ~10⁴⁹ iterations and never
    terminates (the bug this replaces). C(S, S/2) with S=16 is 12,870 — instant — and blocks
    also respect the time-series autocorrelation the period-shuffle destroyed.
    """
    from itertools import combinations
    M = np.asarray(returns_matrix, dtype=float)
    if M.ndim != 2:
        raise ValueError("returns_matrix must be 2-D (n_configs, n_periods)")
    n_configs, T = M.shape
    # PBO across configurations is undefined with <2 configs or <2 periods — return the
    # uninformative midpoint (the caller annotates this as "single config / too short").
    if n_configs < 2 or T < 2:
        return 0.5

    S = min(n_partitions, T)
    if S % 2 == 1:
        S -= 1            # CSCV needs an even block count to split S/2 IS vs S/2 OOS
    if S < 2:
        return 0.5

    bounds = np.linspace(0, T, S + 1).astype(int)
    blocks = [list(range(bounds[b], bounds[b + 1])) for b in range(S)]
    half = S // 2

    below_median = 0
    total = 0
    for is_blocks in combinations(range(S), half):
        is_set = set(is_blocks)
        is_cols: list[int] = []
        oos_cols: list[int] = []
        for b in range(S):
            (is_cols if b in is_set else oos_cols).extend(blocks[b])
        if not is_cols or not oos_cols:
            continue
        is_perf = M[:, is_cols].mean(axis=1)
        oos_perf = M[:, oos_cols].mean(axis=1)
        best_is = int(np.argmax(is_perf))
        if oos_perf[best_is] < float(np.median(oos_perf)):
            below_median += 1
        total += 1

    return below_median / total if total > 0 else 0.5
