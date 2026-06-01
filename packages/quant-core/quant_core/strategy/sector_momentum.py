"""SectorMomentumStrategy — cross-sectional momentum within GICS sectors.

Ranks assets by `rolling_window`-day return relative to their sector mean. The z-score is
applied AFTER sector adjustment (unlike factor_rank, which z-scores each factor first), so
this strategy computes its signal directly with the shared scorer/collaborator utilities
rather than routing through CompositeFactor — composition, no inheritance, no overriding.
"""
from __future__ import annotations

import numpy as np
from typing import Optional

from ..types import StrategyOutput
from .contract import FeatureVector, HistoryView, PortfolioState, StrategyConfig, StrategyParams
from .collaborators.scorer import zscore
from .collaborators.covariance import shrunk_covariance
from .collaborators.regime_engine import RegimeEngine


class SectorMomentumStrategy:
    def __init__(self, regime: RegimeEngine, config: StrategyConfig) -> None:
        self._regime = regime
        self.config = config
        self._sectors: dict[str, str] = {}

    def parameter_space(self) -> dict[str, list[float]]:
        return {}  # no tunables for v1

    def parameter_defaults(self) -> dict[str, float]:
        return {}

    def compute_features(
        self, history: HistoryView, as_of_ms: int, params: StrategyParams
    ) -> Optional[FeatureVector]:
        window = self.config.rolling_window
        candidates = {t for t in history.closes if len(history.closes[t]) >= window}
        tickers = sorted(candidates)
        if len(tickers) < self.config.min_universe_size:
            return None

        prices = np.array([history.closes[t][-window - 1:] for t in tickers], dtype=float)
        returns = np.diff(np.log(prices), axis=1)
        if returns.shape[1] < window:
            return None

        cum_returns = returns[:, -window:].sum(axis=1)

        sectors = [self._sectors.get(t, 'Unknown') for t in tickers]
        sector_means: dict[str, float] = {}
        for sec in set(sectors):
            idxs = [i for i, s in enumerate(sectors) if s == sec]
            sector_means[sec] = float(cum_returns[idxs].mean())

        sector_adj = np.array([
            cum_returns[i] - sector_means[sectors[i]] for i in range(len(tickers))
        ])
        composite = zscore(sector_adj)

        # Degradation signal: when >50% of the universe is 'Unknown', sector-relative
        # ranking degenerates to plain momentum — surfaced for the notification renderer.
        unknown_fraction = sum(1 for s in sectors if s == 'Unknown') / len(sectors)
        degraded_flag = float(unknown_fraction) if unknown_fraction > 0.5 else 0.0

        per_ticker = {
            t: {
                'sector_momentum': float(composite[i]),
                'momentum': float(cum_returns[i]),
                'topology': 0.0,
                'residual_alpha': float(composite[i]),
                'degraded_unknown_sectors': degraded_flag,
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
            cross_sectional_stats={'unknown_fraction': float(unknown_fraction)},
            regime_confidence=regime.confidence,
            position_size_multiplier=1.0,   # sector_momentum emits regime_confidence only
            signal_weights=None,
            sectors=dict(self._sectors),
            covariance_matrix=cov.tolist(),
            feature_stability=None,
        )

    def decide(
        self, features: FeatureVector, portfolio: PortfolioState
    ) -> Optional[StrategyOutput]:
        return StrategyOutput(
            timestamp=features.observation_ts,
            strategy_id=features.strategy_id,
            ticker_universe=features.ticker_universe,
            composite_scores=features.composite_scores,
            factor_attributions=features.per_ticker,
            sectors=features.sectors,
            covariance_matrix=features.covariance_matrix,
            regime_confidence=features.regime_confidence,
            report_cadence=self.config.report_cadence,
            top_k=self.config.top_k,
        )
