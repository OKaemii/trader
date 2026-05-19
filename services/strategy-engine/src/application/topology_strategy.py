import os
import time
import numpy as np
from typing import Optional
from .base_strategy import BaseStrategy, PriceHistoryLookup
from .covariance import shrunk_covariance
from .regime_engine import RegimeEngine
from .diffusion import laplacian_diffusion
from .homology import compute_betti_curves, compute_persistence_pairs
from ..domain.dataclasses import OHLCVBar, StrategyOutput

ROLLING_WINDOW = 20
MIN_HISTORY = 30
# Top-K for topology. Persistence-diagram noise dominates outside the highest-conviction
# names; keep K low until backtests validate. 15 = mid-point between factor-rank (20) and
# sector-momentum (12). Override via TOPOLOGY_TOP_K.
TOP_K = int(os.getenv("TOPOLOGY_TOP_K", "15"))


class TopologyStrategy(BaseStrategy):
    """
    Laplacian diffusion + persistent homology strategy.

    IMPORTANT: Only enable this after FactorRankStrategy has been validated
    with OOS ablation confirming topology adds statistically significant IC.

    The topology signal is added to the composite score only if the ablation
    study (Section 8 of mathematical-foundations.md) confirms residual alpha
    is positive after factor attribution. If it does not add edge, the
    FactorRankStrategy baseline remains the active strategy.
    """

    def __init__(self) -> None:
        self._sectors: dict[str, str] = {}
        self._regime_engine = RegimeEngine()

    @property
    def strategy_id(self) -> str:
        return 'topology_v1'

    @property
    def min_universe_size(self) -> int:
        return 10   # topology requires a minimum universe for meaningful Betti curves

    @property
    def rolling_window(self) -> int:
        # Topology needs more history than the other strategies — Betti curves stabilize
        # with at least MIN_HISTORY observations. Engine host fetches this many bars.
        return MIN_HISTORY

    @property
    def report_cadence(self) -> str:
        # Same cadence policy as FactorRank — daily emits one email per cycle; intraday
        # buckets to hourly so the operator isn't flooded with 5m-window slices.
        return 'per_cycle' if os.getenv('BAR_FREQUENCY', 'daily') == 'daily' else 'hourly'

    def update(
        self,
        bars: list[OHLCVBar],
        history: PriceHistoryLookup,
    ) -> Optional[StrategyOutput]:
        active = set(b.ticker for b in bars)
        tickers = sorted(t for t in active if len(history(t)) >= MIN_HISTORY)
        if len(tickers) < self.min_universe_size:
            return None

        prices = np.array([history(t)[-MIN_HISTORY:] for t in tickers])
        returns = np.diff(np.log(prices), axis=1)    # (n_assets, n_periods - 1)

        if returns.shape[1] < ROLLING_WINDOW:
            return None

        # Laplacian diffusion residuals
        residuals = laplacian_diffusion(returns, alpha=0.1, J=5)

        # Persistent homology — Betti curves and persistence pairs
        betti_curves, epsilon_range = compute_betti_curves(returns, n_bins=100)
        pairs = compute_persistence_pairs(returns)

        # Factor signals
        def zscore(x: np.ndarray) -> np.ndarray:
            std = x.std()
            return (x - x.mean()) / (std + 1e-8) if std > 1e-8 else np.zeros_like(x)

        cum_returns = returns[:, -ROLLING_WINDOW:].sum(axis=1)
        momentum    = zscore(cum_returns)
        reversal    = zscore(-returns[:, -1])
        low_vol     = zscore(-returns[:, -ROLLING_WINDOW:].std(axis=1))
        topo_signal = zscore(-residuals)   # negative residual → underperformed peers → mean-reversion long

        # Ensemble: equal weight for v1 (IC-weighted once backtest validates topology contribution)
        composite = (momentum + reversal + low_vol + topo_signal) / 4.0

        attributions = {
            t: {
                'momentum':      float(momentum[i]),
                'reversal':      float(reversal[i]),
                'low_vol':       float(low_vol[i]),
                'topology':      float(topo_signal[i]),
                'residual_alpha': float(composite[i]),
            }
            for i, t in enumerate(tickers)
        }

        regime = self._regime_engine.update(returns[:, -1])
        cov = shrunk_covariance(returns)

        return StrategyOutput(
            timestamp=int(time.time() * 1000),
            strategy_id=self.strategy_id,
            ticker_universe=tickers,
            composite_scores={t: float(composite[i]) for i, t in enumerate(tickers)},
            factor_attributions=attributions,
            sectors={t: self._sectors.get(t, 'Unknown') for t in tickers},
            covariance_matrix=cov.tolist(),
            regime_confidence=regime.confidence,
            betti_curves={
                'epsilon_range': epsilon_range.tolist(),
                'beta0': betti_curves[0].tolist(),
                'beta1': betti_curves[1].tolist(),
            },
            persistence_pairs=pairs,
            laplacian_residuals={t: float(residuals[i]) for i, t in enumerate(tickers)},
            report_cadence=self.report_cadence,
            top_k=TOP_K,
        )
