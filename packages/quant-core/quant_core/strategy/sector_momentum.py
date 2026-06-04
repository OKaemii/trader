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
        # Tunables sweep within the strategy's history budget (rolling_window=20 — a short-horizon
        # sector rotation). lookback+skip are clamped to what's available, so no grid point fails.
        return {
            'lookback':      [10.0, 15.0, 20.0],   # momentum window (days)
            'skip':          [0.0, 2.0, 5.0],      # skip most-recent days (reversal avoidance)
            'sector_adjust': [0.0, 0.5, 1.0],      # how much of the sector mean to neutralise
        }

    def parameter_defaults(self) -> dict[str, float]:
        # Defaults reproduce the pre-tunable behaviour exactly: full 20-day window, no skip,
        # full sector neutralisation.
        return {'lookback': 20.0, 'skip': 0.0, 'sector_adjust': 1.0}

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

        # Tunable momentum window: total log-return over `lookback` days, ending `skip` days ago
        # (skip avoids the short-term reversal in the most recent days). Both clamped to the data,
        # so any portal/grid value stays valid. Defaults (lookback=window, skip=0) == legacy.
        avail    = returns.shape[1]
        skip     = min(max(0, int(params.get('skip', 0.0))), max(0, avail - 2))
        lookback = min(max(2, int(params.get('lookback', float(window)))), avail - skip)
        sector_adjust = params.get('sector_adjust', 1.0)
        end = avail - skip
        cum_returns = returns[:, end - lookback:end].sum(axis=1)

        sectors = [self._sectors.get(t, 'Unknown') for t in tickers]
        sector_means: dict[str, float] = {}
        for sec in set(sectors):
            idxs = [i for i, s in enumerate(sectors) if s == sec]
            sector_means[sec] = float(cum_returns[idxs].mean())

        sector_adj = np.array([
            cum_returns[i] - sector_adjust * sector_means[sectors[i]] for i in range(len(tickers))
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
