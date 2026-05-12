import numpy as np
from scipy import stats


def sharpe_ratio(returns: np.ndarray, periods_per_year: int = 252) -> float:
    return (returns.mean() / returns.std()) * np.sqrt(periods_per_year) if returns.std() else 0.0


def max_drawdown(equity_curve: np.ndarray) -> float:
    peak = np.maximum.accumulate(equity_curve)
    return float(((equity_curve - peak) / peak).min())


def information_coefficient(predicted_weights: np.ndarray, realized_returns: np.ndarray) -> float:
    ic, _ = stats.spearmanr(predicted_weights, realized_returns)
    return float(ic)


def ic_t_test(ic_series: np.ndarray) -> tuple[float, float]:
    return stats.ttest_1samp(ic_series, 0)  # H₀: mean IC = 0


def cvar_95(returns: np.ndarray) -> float:
    cutoff = np.percentile(returns, 5)
    tail = returns[returns <= cutoff]
    return float(tail.mean()) if len(tail) > 0 else float(cutoff)


def alpha_half_life(ic_series: np.ndarray) -> float:
    """Estimates alpha half-life from IC autocorrelation at lag 1."""
    if len(ic_series) < 10:
        return float('inf')
    rho = float(np.corrcoef(ic_series[:-1], ic_series[1:])[0, 1])
    if rho <= 0 or rho >= 1:
        return 1.0
    return float(np.log(0.5) / np.log(rho))
