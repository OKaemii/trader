"""TopologyStrategy — Laplacian diffusion + persistent homology overlay on the factor blend.

GATED OFF until backtest validation confirms topology adds significant OOS IC (see
tda-economic-rationale.md). Composes the topology kernels + RegimeEngine + covariance and
computes its 4-factor equal-weight blend directly (momentum uses a 20-bar sub-window of the
30-bar history, so it does not share factor_rank's leaf definitions).
"""
from __future__ import annotations

import numpy as np
from typing import Optional

from ..types import StrategyOutput
from .contract import FeatureVector, HistoryView, PortfolioState, StrategyConfig, StrategyParams
from .collaborators.scorer import zscore
from .collaborators.covariance import shrunk_covariance
from .collaborators.regime_engine import RegimeEngine
from .collaborators.topology_kernels import (
    compute_betti_curves,
    compute_persistence_pairs,
    laplacian_diffusion,
)

ROLLING_WINDOW = 20   # momentum/low_vol sub-window
MIN_HISTORY = 30      # bars of history the host must supply (== config.rolling_window)


class TopologyStrategy:
    def __init__(self, regime: RegimeEngine, config: StrategyConfig) -> None:
        self._regime = regime
        self.config = config
        self._sectors: dict[str, str] = {}

    def parameter_space(self) -> dict[str, list[float]]:
        return {}

    def parameter_defaults(self) -> dict[str, float]:
        return {}

    def compute_features(
        self, history: HistoryView, as_of_ms: int, params: StrategyParams
    ) -> Optional[FeatureVector]:
        tickers = sorted(t for t in history.closes if len(history.closes[t]) >= MIN_HISTORY)
        if len(tickers) < self.config.min_universe_size:
            return None

        prices = np.array([history.closes[t][-MIN_HISTORY:] for t in tickers], dtype=float)
        returns = np.diff(np.log(prices), axis=1)
        if returns.shape[1] < ROLLING_WINDOW:
            return None

        residuals = laplacian_diffusion(returns, alpha=0.1, J=5)
        betti_curves, epsilon_range = compute_betti_curves(returns, n_bins=100)
        pairs = compute_persistence_pairs(returns)

        cum_returns = returns[:, -ROLLING_WINDOW:].sum(axis=1)
        momentum    = zscore(cum_returns)
        reversal    = zscore(-returns[:, -1])
        low_vol     = zscore(-returns[:, -ROLLING_WINDOW:].std(axis=1))
        topo_signal = zscore(-residuals)
        composite   = (momentum + reversal + low_vol + topo_signal) / 4.0

        per_ticker = {
            t: {
                'momentum':       float(momentum[i]),
                'reversal':       float(reversal[i]),
                'low_vol':        float(low_vol[i]),
                'topology':       float(topo_signal[i]),
                'residual_alpha': float(composite[i]),
            }
            for i, t in enumerate(tickers)
        }
        composite_scores = {t: float(composite[i]) for i, t in enumerate(tickers)}

        regime = self._regime.update(returns[:, -1])
        cov = shrunk_covariance(returns)

        return FeatureVector(
            strategy_id=self.config.strategy_id,
            observation_ts=as_of_ms,
            ticker_universe=tickers,
            composite_scores=composite_scores,
            per_ticker=per_ticker,
            cross_sectional_stats={},
            regime_confidence=regime.confidence,
            position_size_multiplier=1.0,
            signal_weights=None,
            sectors={t: self._sectors.get(t, 'Unknown') for t in tickers},
            covariance_matrix=cov.tolist(),
            feature_stability=None,
            extras={
                'betti_curves': {
                    'epsilon_range': epsilon_range.tolist(),
                    'beta0': betti_curves[0].tolist(),
                    'beta1': betti_curves[1].tolist(),
                },
                'persistence_pairs': pairs,
                'laplacian_residuals': {t: float(residuals[i]) for i, t in enumerate(tickers)},
            },
        )

    def decide(
        self, features: FeatureVector, portfolio: PortfolioState
    ) -> Optional[StrategyOutput]:
        extras = features.extras or {}
        return StrategyOutput(
            timestamp=features.observation_ts,
            strategy_id=features.strategy_id,
            ticker_universe=features.ticker_universe,
            composite_scores=features.composite_scores,
            factor_attributions=features.per_ticker,
            sectors=features.sectors,
            covariance_matrix=features.covariance_matrix,
            regime_confidence=features.regime_confidence,
            betti_curves=extras.get('betti_curves'),
            persistence_pairs=extras.get('persistence_pairs'),
            laplacian_residuals=extras.get('laplacian_residuals'),
            report_cadence=self.config.report_cadence,
            top_k=self.config.top_k,
        )
