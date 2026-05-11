import numpy as np
from gtda.homology import VietorisRipsPersistence
from gtda.diagrams import BettiCurve


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
