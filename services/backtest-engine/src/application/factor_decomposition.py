import numpy as np

SANITY_CHECK_FACTORS = [
    'momentum_1m',
    'momentum_12m',
    'short_term_reversal',
    'liquidity',
    'volatility',
    'size',
]


def factor_attribution(signal_returns: np.ndarray, factor_returns: np.ndarray) -> dict:
    """
    OLS regression of signal returns on known factors.
    Returns factor coefficients, residual alpha, and R².
    Residual alpha must be positive and statistically significant for go-live.
    """
    from numpy.linalg import lstsq
    X = np.column_stack([factor_returns, np.ones(len(factor_returns))])
    coefs, _, _, _ = lstsq(X, signal_returns, rcond=None)
    residual_alpha = coefs[-1]
    factor_coefs = dict(zip(SANITY_CHECK_FACTORS[:factor_returns.shape[1]], coefs[:-1]))
    r_squared = 1 - np.var(signal_returns - X @ coefs) / np.var(signal_returns)
    return {
        'factor_coefs':    factor_coefs,
        'residual_alpha':  float(residual_alpha),
        'r_squared':       float(r_squared),
    }


def newey_west_tstat(residuals: np.ndarray, alpha: float, lags: int = 5) -> float:
    """Newey-West HAC t-statistic for residual alpha."""
    T = len(residuals)
    if T < lags + 2:
        return 0.0
    gamma0 = float(np.var(residuals))
    nw_var = gamma0
    for l in range(1, lags + 1):
        gamma_l = float(np.cov(residuals[l:], residuals[:-l])[0, 1])
        nw_var += 2 * (1 - l / (lags + 1)) * gamma_l
    se = np.sqrt(nw_var / T)
    return float(alpha / se) if se > 0 else 0.0
