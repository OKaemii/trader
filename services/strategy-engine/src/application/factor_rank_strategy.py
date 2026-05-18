import os
import time
import dataclasses
import numpy as np
from typing import Optional
from .base_strategy import BaseStrategy, PriceHistoryLookup
from .covariance import shrunk_covariance
from .regime_engine import RegimeEngine
from .feature_stability import FeatureStabilityAnalyser
from ..domain.dataclasses import OHLCVBar, StrategyOutput

# BAR_FREQUENCY=daily → 20 bars = 20 trading days; BAR_FREQUENCY=intraday → 60 bars (shorter horizon)
ROLLING_WINDOW = int(os.getenv("ROLLING_WINDOW_BARS", "20" if os.getenv("BAR_FREQUENCY", "daily") == "daily" else "60"))
STABILITY_WINDOW = 30  # cycles to accumulate before running stability analysis


class FactorRankStrategy(BaseStrategy):
    """
    Simple multi-factor cross-sectional ranking strategy.

    Factors:
    - Momentum: 20-day return (short-window cross-sectional)
    - Reversal: 1-day return (short-term mean-reversion)
    - Volatility: negative 20-day realised vol (prefer low-vol assets)

    This is the starting strategy — validate it before enabling TopologyStrategy.
    The interface is stable: downstream services consume StrategyOutput regardless
    of which strategy produced it.

    Per the plan: ACTIVE_STRATEGY=factor_rank_v1 is the default start.
    """

    LOOKBACK = ROLLING_WINDOW

    @property
    def rolling_window(self) -> int:
        return self.LOOKBACK

    def __init__(self) -> None:
        self._sectors: dict[str, str] = {}
        self._regime_engine = RegimeEngine()
        self._stability_analyser = FeatureStabilityAnalyser()
        # Rolling history for stability analysis: feature_name → list of cross-sectional mean values.
        # This IS cycle-to-cycle state — it tracks how feature means evolve over time, not bars.
        # Survives across cycles to detect drift; reset only on a pod restart.
        self._feature_history: dict[str, list[float]] = {
            'momentum': [], 'reversal': [], 'low_vol': [],
        }

    @property
    def strategy_id(self) -> str:
        return 'factor_rank_v1'

    @property
    def min_universe_size(self) -> int:
        return 5

    @property
    def prewarm_cycles(self) -> int:
        # Match RegimeEngine's own self-imposed retention cap so the regime + feature-
        # stability state reach steady state by cycle 1. Beyond this the engine pops
        # the oldest vector, so feeding more is wasted compute.
        return RegimeEngine.HISTORY_MIN * 2

    def update(
        self,
        bars: list[OHLCVBar],
        history: PriceHistoryLookup,
    ) -> Optional[StrategyOutput]:
        active = set(b.ticker for b in bars)
        for t in active:
            self._sectors.setdefault(t, 'Unknown')

        tickers = sorted(t for t in active if len(history(t)) >= self.LOOKBACK)
        if len(tickers) < self.min_universe_size:
            return None

        # Take the most recent LOOKBACK closes per ticker. history() returns oldest-first.
        prices = np.array([history(t)[-self.LOOKBACK:] for t in tickers])
        returns = np.diff(np.log(prices), axis=1)   # (n_assets, n_periods - 1)

        if returns.shape[1] < 2:
            return None

        # Cross-sectional z-scores for each factor
        def zscore(x: np.ndarray) -> np.ndarray:
            std = x.std()
            return (x - x.mean()) / (std + 1e-8) if std > 1e-8 else np.zeros_like(x)

        momentum  = zscore(returns[:, -self.LOOKBACK:].sum(axis=1))    # 20-day return
        reversal  = zscore(-returns[:, -1])                             # 1-day reversal
        low_vol   = zscore(-returns[:, -self.LOOKBACK:].std(axis=1))   # negative vol

        # IC-weighted combination (equal IC weights for v1 — updated from backtest results)
        composite = (momentum + reversal + low_vol) / 3.0

        # Factor attributions (for rationale builder in signal-service)
        attributions: dict[str, dict[str, float]] = {}
        for i, t in enumerate(tickers):
            attributions[t] = {
                'momentum':     float(momentum[i]),
                'reversal':     float(reversal[i]),
                'low_vol':      float(low_vol[i]),
                'topology':     0.0,
                'residual_alpha': float(composite[i]),
            }

        # Regime confidence + soft multipliers
        cross_sectional_returns = returns[:, -1]
        regime = self._regime_engine.update(cross_sectional_returns)

        # Feature stability — accumulate cross-sectional means, analyse after warm-up
        self._feature_history['momentum'].append(float(momentum.mean()))
        self._feature_history['reversal'].append(float(reversal.mean()))
        self._feature_history['low_vol'].append(float(low_vol.mean()))
        for k in self._feature_history:
            if len(self._feature_history[k]) > STABILITY_WINDOW * 2:
                self._feature_history[k].pop(0)

        stability_report = None
        if len(self._feature_history['momentum']) >= STABILITY_WINDOW:
            report = self._stability_analyser.analyse(self._feature_history)
            stability_report = dataclasses.asdict(report)

        # Ledoit-Wolf covariance
        cov = shrunk_covariance(returns)

        return StrategyOutput(
            timestamp=int(time.time() * 1000),
            strategy_id=self.strategy_id,
            ticker_universe=tickers,
            composite_scores={t: float(composite[i]) for i, t in enumerate(tickers)},
            factor_attributions=attributions,
            sectors=self._sectors,
            covariance_matrix=cov.tolist(),
            regime_confidence=regime.confidence,
            position_size_multiplier=regime.position_size_multiplier,
            signal_weights=regime.signal_weights,
            feature_stability=stability_report,
        )
