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
    """
    Simplified CSCV-based PBO estimate.
    returns_matrix: (n_configs, n_periods). Returns PBO ∈ [0, 1]; > 0.5 = likely overfit.
    """
    from itertools import combinations
    n_configs, T = returns_matrix.shape
    half = T // 2
    oos_underperform = 0
    total = 0

    for is_idx in combinations(range(T), half):
        oos_idx = [i for i in range(T) if i not in is_idx]
        is_perf = returns_matrix[:, list(is_idx)].mean(axis=1)
        oos_perf = returns_matrix[:, oos_idx].mean(axis=1)
        best_is = int(np.argmax(is_perf))
        median_oos = float(np.median(oos_perf))
        if oos_perf[best_is] < median_oos:
            oos_underperform += 1
        total += 1

    return oos_underperform / total if total > 0 else 0.5
