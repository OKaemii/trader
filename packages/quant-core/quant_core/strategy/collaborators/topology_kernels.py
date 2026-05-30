"""Pure topology kernels used by TopologyStrategy: Laplacian diffusion residuals
(`diffusion.py`) + persistent-homology Betti curves / persistence pairs (`homology.py`),
merged into one module since they are the same concern (correlation-graph topology) and
only TopologyStrategy consumes them.

The neural training pipeline (`neural.py`) is deliberately NOT here — it depends on torch
and strategy-engine infrastructure (model_store_client) and is not part of the strategy
contract, so keeping it in quant-core would violate the Stable Dependencies Principle.
"""
import numpy as np
from scipy.sparse.csgraph import laplacian as scipy_laplacian
from gtda.homology import VietorisRipsPersistence
from gtda.diagrams import BettiCurve


# ── Laplacian diffusion (was diffusion.py) ─────────────────────────────────────

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


# ── Persistent homology (was homology.py) ──────────────────────────────────────

def distance_matrix_from_correlation(returns_matrix: np.ndarray) -> np.ndarray:
    """
    Convert correlation matrix to the standard financial metric:
    d(i,j) = sqrt(2 * (1 - rho_{ij}))

    This is a valid metric (see mathematical-foundations.md Proposition 1).
    """
    corr = np.corrcoef(returns_matrix)
    np.clip(corr, -1, 1, out=corr)
    return np.sqrt(2 * (1 - corr))


def compute_betti_curves(
    returns_matrix: np.ndarray,
    n_bins: int = 100,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Compute Betti curves (β₀, β₁) from the Vietoris-Rips filtration of the
    correlation-derived distance matrix.

    Returns
    -------
    betti_curves : (2, n_bins) — row 0 = β₀, row 1 = β₁
    epsilon_range : (n_bins,)
    """
    dist = distance_matrix_from_correlation(returns_matrix)
    vr = VietorisRipsPersistence(
        metric="precomputed",
        homology_dimensions=[0, 1],
        collapse_edges=True,
    )
    diagrams = vr.fit_transform([dist])     # shape (1, n_pairs, 3)

    bc = BettiCurve(n_bins=n_bins)
    curves = bc.fit_transform(diagrams)     # shape (1, n_bins, 2)

    epsilon_range = np.linspace(0, float(dist.max()), n_bins)
    return curves[0].T, epsilon_range       # (2, n_bins), (n_bins,)


def compute_persistence_pairs(returns_matrix: np.ndarray) -> list[tuple[float, float, int]]:
    """
    Returns list of (birth, death, dimension) persistence pairs.
    Used for persistence diagram visualisation in the frontend.
    """
    dist = distance_matrix_from_correlation(returns_matrix)
    vr = VietorisRipsPersistence(
        metric="precomputed",
        homology_dimensions=[0, 1],
    )
    diagrams = vr.fit_transform([dist])
    return [
        (float(b), float(d), int(dim))
        for b, d, dim in diagrams[0]
        if d < np.inf
    ]
