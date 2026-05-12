from dataclasses import dataclass
import numpy as np


@dataclass
class RegimeState:
    p_trending: float        # probability of trending (bull/bear momentum) regime
    p_high_vol: float        # probability of high-volatility regime
    p_expanding: float       # probability of dispersion-expanding regime
    p_crisis: float          # probability of crisis / correlation spike regime
    position_size_multiplier: float = 1.0  # [0.25, 1.0]; reduced in high-risk regimes


ABLATION_VARIANTS = {
    'baseline':         {'signals': ['cross_sectional_momentum'], 'use_neural': False},
    'laplacian_only':   {'signals': ['residual_reversion'],       'use_neural': False},
    'topology_only':    {'signals': ['residual_reversion', 'topology_alpha'], 'use_neural': False},
    'ensemble_no_topo': {'signals': ['residual_reversion', 'vol_compression', 'breadth',
                                     'cross_sectional_momentum', 'correlation_instability'], 'use_neural': False},
    'full_ensemble':    {'signals': ['residual_reversion', 'vol_compression', 'breadth',
                                     'cross_sectional_momentum', 'correlation_instability',
                                     'diffusion_imbalance', 'topology_alpha'], 'use_neural': False},
    'full_model':       {'signals': 'all', 'use_neural': True},
}


def classify_regime(
    returns: np.ndarray,    # (n_assets, n_periods)
    beta1_pct: float = 0.0, # fraction of assets with persistent β₁ loops
) -> RegimeState:
    """4-dimension soft probabilistic regime classification — no hard labels."""
    if returns.shape[1] < 20:
        return RegimeState(p_trending=0.5, p_high_vol=0.5, p_expanding=0.3, p_crisis=0.1)

    portfolio_returns = returns.mean(axis=0)
    recent_returns = portfolio_returns[-20:]
    vol = float(recent_returns.std() * np.sqrt(252))
    hurst = _estimate_hurst(portfolio_returns[-60:] if len(portfolio_returns) >= 60 else portfolio_returns)

    p_trending = _sigmoid(hurst, center=0.5, scale=0.1)
    p_high_vol = _sigmoid(vol, center=0.20, scale=0.05)
    vol_pct = min(vol / 0.40, 1.0)
    p_expanding = _sigmoid(float(returns.std(axis=0).mean()), center=0.015, scale=0.005)
    p_crisis = p_high_vol * beta1_pct * max(0, vol_pct - 0.8) / 0.2 if vol_pct > 0.8 else 0.0

    multiplier = max(0.25, 1.0 - 0.5 * p_crisis - 0.25 * p_high_vol)

    return RegimeState(
        p_trending=float(np.clip(p_trending, 0, 1)),
        p_high_vol=float(p_high_vol),
        p_expanding=float(np.clip(p_expanding, 0, 1)),
        p_crisis=float(np.clip(p_crisis, 0, 1)),
        position_size_multiplier=float(np.clip(multiplier, 0.25, 1.0)),
    )


def regime_breakdown(returns: np.ndarray, regime_labels: np.ndarray) -> dict:
    """IC, Sharpe, and sample count per regime label — surfaced in ValidationReport."""
    result = {}
    for label in np.unique(regime_labels):
        mask = regime_labels == label
        if mask.sum() < 20:
            result[str(label)] = {'n_obs': int(mask.sum()), 'sharpe': None, 'note': 'insufficient sample'}
            continue
        r = returns[mask]
        result[str(label)] = {
            'n_obs':  int(mask.sum()),
            'sharpe': float(r.mean() / r.std() * np.sqrt(252)) if r.std() > 0 else 0.0,
        }
    return result


def _sigmoid(x: float, center: float, scale: float) -> float:
    return 1.0 / (1.0 + np.exp(-(x - center) / scale))


def _estimate_hurst(returns: np.ndarray) -> float:
    """Simple R/S Hurst exponent estimate. H > 0.5 → trending, H < 0.5 → mean-reverting."""
    n = len(returns)
    if n < 20:
        return 0.5
    mean = returns.mean()
    deviation = np.cumsum(returns - mean)
    r = deviation.max() - deviation.min()
    s = returns.std()
    return float(np.log(r / s) / np.log(n)) if s > 0 else 0.5
