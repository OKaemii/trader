import numpy as np
from scipy.sparse.csgraph import laplacian as scipy_laplacian


def correlation_matrix(returns_matrix: np.ndarray) -> np.ndarray:
    """
    returns_matrix: shape (n_assets, n_periods)
    Returns symmetric correlation matrix, values clipped to [0, 1] for graph weights.
    Only positive correlations are used as edge weights.
    """
    corr = np.corrcoef(returns_matrix)
    np.fill_diagonal(corr, 0)
    return np.clip(corr, 0, 1)


def laplacian_diffusion(
    returns_matrix: np.ndarray,
    alpha: float = 0.1,
    J: int = 5,
) -> np.ndarray:
    """
    Laplacian diffusion residual extraction.

    h = (I - alpha * L_sym)^J @ x    (graph-smooth consensus return)
    e = x - h                          (Laplacian residuals = local mispricings)

    Positive e_i: asset i outperformed its network neighbourhood (potential short signal).
    Negative e_i: underperformed (potential mean-reversion long signal).

    Parameters
    ----------
    returns_matrix : (n_assets, n_periods)
    alpha          : step-size in (0, 1/lambda_max)
    J              : diffusion depth (number of hops)

    Returns
    -------
    e : (n_assets,) residual mispricing vector for the most recent period
    """
    x = returns_matrix[:, -1]          # latest cross-sectional return vector
    C = correlation_matrix(returns_matrix)
    # Add small regularisation to ensure D_ii > 0 for all i
    C = C + 1e-6 * np.eye(len(C))
    L = scipy_laplacian(C, normed=True)
    I = np.eye(len(L))
    diffusion_op = np.linalg.matrix_power(I - alpha * L, J)
    h = diffusion_op @ x
    return x - h
