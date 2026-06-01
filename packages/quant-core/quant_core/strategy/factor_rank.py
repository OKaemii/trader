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
from .collaborators.trend_filter import TrendFilter
import dataclasses

STABILITY_WINDOW = 30  # cycles to accumulate before running stability analysis


class FactorRankStrategy:
    def __init__(
        self,
        factor,                              # CompositeFactor (a Factor)
        regime: RegimeEngine,
        stability: FeatureStabilityAnalyser,
        trend: TrendFilter,
        config: StrategyConfig,
    ) -> None:
        self._factor = factor
        self._regime = regime
        self._stability = stability
        self._trend = trend
        self.config = config
        self._sectors: dict[str, str] = {}
        # Cross-cycle state for stability tracking. Phase 1 makes this stateless (read the
        # window from the FeatureStore); for now it preserves the live behaviour.
        self._feature_history: dict[str, list[float]] = {
            'momentum': [], 'reversal': [], 'low_vol': [],
        }

    def parameter_space(self) -> dict[str, list[float]]:
        # Lean default sweep (≈12 points = legacy MCPT cost). The full knob set lives in
        # parameter_defaults() for live tuning + the portal grid editor; widen deliberately
        # there since MCPT cost scales with the cartesian-product size.
        return {
            'w_momentum': [0.5, 1.0, 1.5],
            'mom_lookback': [126.0, 252.0],
            'trend_risk_off_mult': [0.0, 1.0],
        }

    def parameter_defaults(self) -> dict[str, float]:
        return {
            'w_momentum': 1.0, 'w_low_vol': 0.5, 'w_reversal': 0.0,
            'mom_lookback': 252.0, 'mom_skip': 21.0,
            'abs_lookback': 252.0, 'abs_threshold': 0.0,
            'trend_risk_off_mult': 0.0, 'breadth_floor': 0.4,
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
        composite_all = {t: bd[t]['composite'] for t in tickers}

        # Defensive overlay (composition): keep only uptrending names + a breadth-driven gross
        # exposure scalar. Covariance / universe / scores are all realigned to the held set so
        # the optimiser sees a consistent (scores, cov, universe) triple.
        held_scores, trend_exposure, trend_tel = self._trend.apply(composite_all, history, params)
        held_idx = [i for i, t in enumerate(tickers) if t in held_scores]
        held_tickers = [tickers[i] for i in held_idx]
        if len(held_tickers) < self.config.min_universe_size:
            return None   # too few uptrending names — stay defensive, emit nothing this cycle

        composite_scores = {t: held_scores[t] for t in held_tickers}
        per_ticker = {
            t: {
                'momentum':       bd[t]['momentum'],
                'reversal':       bd[t]['reversal'],
                'low_vol':        bd[t]['low_vol'],
                'topology':       0.0,
                'residual_alpha': bd[t]['composite'],
            }
            for t in held_tickers
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

        cov = shrunk_covariance(returns[held_idx])   # held subset — aligns with ticker_universe

        return FeatureVector(
            strategy_id=self.config.strategy_id,
            observation_ts=as_of_ms,
            ticker_universe=held_tickers,
            composite_scores=composite_scores,
            per_ticker=per_ticker,
            cross_sectional_stats={
                'momentum_mean': m_mean, 'reversal_mean': r_mean, 'low_vol_mean': l_mean,
                'trend_breadth': trend_tel['breadth'], 'trend_held': trend_tel['n_qualifying'],
            },
            regime_confidence=regime.confidence,
            position_size_multiplier=regime.position_size_multiplier * trend_exposure,
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
