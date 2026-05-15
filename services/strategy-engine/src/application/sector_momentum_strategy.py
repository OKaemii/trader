import time
import numpy as np
from typing import Optional
from .base_strategy import BaseStrategy, PriceHistoryLookup
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

    History is fetched by the engine host from Mongo via market-data-service; this
    class is stateless across cycles (the only state it holds is sector metadata
    and the regime engine).
    """

    @property
    def strategy_id(self) -> str:
        return 'sector_momentum_v1'

    @property
    def min_universe_size(self) -> int:
        return 5

    @property
    def rolling_window(self) -> int:
        return ROLLING_WINDOW

    def __init__(self) -> None:
        self._sectors: dict[str, str] = {}
        self._regime_engine = RegimeEngine()

    def update(
        self,
        bars: list[OHLCVBar],
        history: PriceHistoryLookup,
    ) -> Optional[StrategyOutput]:
        # Tickers "active" this cycle = union of bar batch and any ticker we already
        # have enough history for. The bar batch can be smaller than the universe
        # (e.g. a single fresh bar per ticker per poll) but we score every ticker
        # whose history meets the window — that's what makes the engine stateless.
        active = set(b.ticker for b in bars)
        candidates = {t for t in active if len(history(t)) >= ROLLING_WINDOW}
        tickers = sorted(candidates)
        if len(tickers) < self.min_universe_size:
            return None

        prices = np.array([history(t)[-ROLLING_WINDOW - 1:] for t in tickers])
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
