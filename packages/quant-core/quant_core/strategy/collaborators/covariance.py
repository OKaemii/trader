import numpy as np
from sklearn.covariance import LedoitWolf


def shrunk_covariance(returns_matrix: np.ndarray) -> np.ndarray:
    """
    Estimate the Ledoit-Wolf shrunk covariance matrix.

    Parameters
    ----------
    returns_matrix : shape (n_assets, n_periods)
        Asset log-returns, columns = time periods.

    Returns
    -------
    cov : shape (n_assets, n_assets)
        Shrunk covariance matrix; positive semi-definite and well-conditioned.
    """
    # LedoitWolf expects shape (n_samples, n_features) = (n_periods, n_assets)
    X = returns_matrix.T
    lw = LedoitWolf(assume_centered=False)
    lw.fit(X)
    cov = lw.covariance_

    # Condition number check — fallback to equal-weight diagonal if numerically unstable
    eigenvalues = np.linalg.eigvalsh(cov)
    lambda_min = eigenvalues[eigenvalues > 0].min() if (eigenvalues > 0).any() else 1e-8
    lambda_max = eigenvalues.max()
    kappa = lambda_max / lambda_min if lambda_min > 0 else np.inf

    if kappa > 500:
        print(f"[covariance] condition number {kappa:.0f} > 500 — falling back to diagonal")
        cov = np.diag(np.var(X, axis=0))

    return cov
