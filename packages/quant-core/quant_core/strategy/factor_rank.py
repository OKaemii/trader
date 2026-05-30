"""FactorRankStrategy — multi-factor cross-sectional ranking, expressed as a CompositeFactor.

This is the live default (ACTIVE_STRATEGY=factor_rank_v1). It composes:
  - a CompositeFactor([Momentum, Reversal, LowVol]) — equal weight == the legacy
    `(momentum + reversal + low_vol) / 3` (answers "composite vs overriding?" → Composite);
  - a RegimeEngine (regime confidence + soft multipliers);
  - a FeatureStabilityAnalyser (CV + ADF flags);
  - a covariance estimator (Ledoit-Wolf).

No inheritance, no overriding — `Strategy` is satisfied structurally.
"""
from __future__ import annotations

import numpy as np
from typing import Optional

from ..types import StrategyOutput
from .contract import FeatureVector, HistoryView, PortfolioState, StrategyConfig, StrategyParams
from .collaborators.scorer import eligible_returns
from .collaborators.covariance import shrunk_covariance
from .collaborators.regime_engine import RegimeEngine
from .collaborators.feature_stability import FeatureStabilityAnalyser
import dataclasses

STABILITY_WINDOW = 30  # cycles to accumulate before running stability analysis


class FactorRankStrategy:
    def __init__(
        self,
        factor,                              # CompositeFactor (a Factor)
        regime: RegimeEngine,
        stability: FeatureStabilityAnalyser,
        config: StrategyConfig,
    ) -> None:
        self._factor = factor
        self._regime = regime
        self._stability = stability
        self.config = config
        self._sectors: dict[str, str] = {}
        # Cross-cycle state for stability tracking. Phase 1 makes this stateless (read the
        # window from the FeatureStore); for now it preserves the live behaviour.
        self._feature_history: dict[str, list[float]] = {
            'momentum': [], 'reversal': [], 'low_vol': [],
        }

    def parameter_space(self) -> dict[str, list[float]]:
        return {
            'w_momentum': [0.5, 1.0, 1.5],
            'w_reversal': [0.5, 1.0],
            'w_low_vol': [0.5, 1.0],
        }

    def compute_features(
        self, history: HistoryView, as_of_ms: int, params: StrategyParams
    ) -> Optional[FeatureVector]:
        window = self.config.rolling_window
        for t in history.closes:
            self._sectors.setdefault(t, 'Unknown')

        tickers, returns = eligible_returns(history, window)
        if len(tickers) < self.config.min_universe_size:
            return None

        bd = self._factor.breakdown(history, window, params)
        composite_scores = {t: bd[t]['composite'] for t in tickers}
        per_ticker = {
            t: {
                'momentum':       bd[t]['momentum'],
                'reversal':       bd[t]['reversal'],
                'low_vol':        bd[t]['low_vol'],
                'topology':       0.0,
                'residual_alpha': bd[t]['composite'],
            }
            for t in tickers
        }

        # Regime confidence + soft multipliers (from the last cross-sectional return vector).
        regime = self._regime.update(returns[:, -1])

        # Feature stability — accumulate cross-sectional means, analyse after warm-up.
        m_mean = float(np.mean([bd[t]['momentum'] for t in tickers]))
        r_mean = float(np.mean([bd[t]['reversal'] for t in tickers]))
        l_mean = float(np.mean([bd[t]['low_vol'] for t in tickers]))
        self._feature_history['momentum'].append(m_mean)
        self._feature_history['reversal'].append(r_mean)
        self._feature_history['low_vol'].append(l_mean)
        for k in self._feature_history:
            if len(self._feature_history[k]) > STABILITY_WINDOW * 2:
                self._feature_history[k].pop(0)
        feature_stability = None
        if len(self._feature_history['momentum']) >= STABILITY_WINDOW:
            feature_stability = dataclasses.asdict(self._stability.analyse(self._feature_history))

        cov = shrunk_covariance(returns)

        return FeatureVector(
            strategy_id=self.config.strategy_id,
            observation_ts=as_of_ms,
            ticker_universe=tickers,
            composite_scores=composite_scores,
            per_ticker=per_ticker,
            cross_sectional_stats={
                'momentum_mean': m_mean, 'reversal_mean': r_mean, 'low_vol_mean': l_mean,
            },
            regime_confidence=regime.confidence,
            position_size_multiplier=regime.position_size_multiplier,
            signal_weights=regime.signal_weights,
            sectors=dict(self._sectors),
            covariance_matrix=cov.tolist(),
            feature_stability=feature_stability,
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
            position_size_multiplier=features.position_size_multiplier,
            signal_weights=features.signal_weights,
            feature_stability=features.feature_stability,
            report_cadence=self.config.report_cadence,
            top_k=self.config.top_k,
        )
