import time
import numpy as np
from typing import Optional
from .base_strategy import BaseStrategy
from .covariance import shrunk_covariance
from .regime_engine import RegimeEngine
from ..domain.dataclasses import OHLCVBar, StrategyOutput

ROLLING_WINDOW = 20   # days for momentum, reversal, volatility factors


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

    def __init__(self) -> None:
        self._price_history: dict[str, list[float]] = {}
        self._sectors: dict[str, str] = {}
        self._regime_engine = RegimeEngine()

    @property
    def strategy_id(self) -> str:
        return 'factor_rank_v1'

    @property
    def min_universe_size(self) -> int:
        return 5

    def update(self, bars: list[OHLCVBar]) -> Optional[StrategyOutput]:
        # Accumulate price history
        for bar in bars:
            if bar.ticker not in self._price_history:
                self._price_history[bar.ticker] = []
                self._sectors[bar.ticker] = 'Unknown'
            self._price_history[bar.ticker].append(bar.close)
            if len(self._price_history[bar.ticker]) > self.LOOKBACK + 2:
                self._price_history[bar.ticker].pop(0)

        tickers = [t for t, hist in self._price_history.items() if len(hist) >= self.LOOKBACK]
        if len(tickers) < self.min_universe_size:
            return None

        prices = np.array([self._price_history[t] for t in tickers])
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

        # Regime confidence
        cross_sectional_returns = returns[:, -1]
        regime = self._regime_engine.update(cross_sectional_returns)

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
        )
