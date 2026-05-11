import time
import numpy as np
from typing import Optional
from .base_strategy import BaseStrategy
from .covariance import shrunk_covariance
from .regime_engine import RegimeEngine
from ..domain.dataclasses import OHLCVBar, StrategyOutput

ROLLING_WINDOW = 20


class SectorMomentumStrategy(BaseStrategy):
    """
    Cross-sectional momentum within GICS sectors.

    Ranks assets by 20-day return relative to their sector's average.
    Sector-adjusted momentum reduces the impact of broad sector rotations
    and focusses on stock-specific relative strength.
    """

    @property
    def strategy_id(self) -> str:
        return 'sector_momentum_v1'

    @property
    def min_universe_size(self) -> int:
        return 5

    def __init__(self) -> None:
        self._price_history: dict[str, list[float]] = {}
        self._sectors: dict[str, str] = {}
        self._regime_engine = RegimeEngine()

    def update(self, bars: list[OHLCVBar]) -> Optional[StrategyOutput]:
        for bar in bars:
            if bar.ticker not in self._price_history:
                self._price_history[bar.ticker] = []
            self._price_history[bar.ticker].append(bar.close)
            if len(self._price_history[bar.ticker]) > ROLLING_WINDOW + 2:
                self._price_history[bar.ticker].pop(0)

        tickers = [t for t, hist in self._price_history.items() if len(hist) >= ROLLING_WINDOW]
        if len(tickers) < self.min_universe_size:
            return None

        prices = np.array([self._price_history[t] for t in tickers])
        returns = np.diff(np.log(prices), axis=1)
        if returns.shape[1] < ROLLING_WINDOW:
            return None

        cum_returns = returns[:, -ROLLING_WINDOW:].sum(axis=1)

        # Sector-neutral: subtract sector mean from each asset's return
        sectors = [self._sectors.get(t, 'Unknown') for t in tickers]
        sector_means: dict[str, float] = {}
        for sec in set(sectors):
            idxs = [i for i, s in enumerate(sectors) if s == sec]
            sector_means[sec] = float(cum_returns[idxs].mean())

        sector_adj = np.array([
            cum_returns[i] - sector_means[sectors[i]]
            for i in range(len(tickers))
        ])

        def zscore(x: np.ndarray) -> np.ndarray:
            std = x.std()
            return (x - x.mean()) / (std + 1e-8) if std > 1e-8 else np.zeros_like(x)

        composite = zscore(sector_adj)

        attributions = {
            t: {'sector_momentum': float(composite[i]), 'momentum': float(cum_returns[i]),
                'topology': 0.0, 'residual_alpha': float(composite[i])}
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
            sectors=self._sectors,
            covariance_matrix=cov.tolist(),
            regime_confidence=regime.confidence,
        )
