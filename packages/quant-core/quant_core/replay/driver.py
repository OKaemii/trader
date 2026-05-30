"""Replay — the single path that turns a strategy + history into per-rebalance target weights.

Live emission (strategy-engine) and backtest replay (backtest-engine) both flow through
compute_features → decide; this driver formalises the replay side (walk a clock, write
features with is_replay=TRUE, optimise weights). Every dependency is a Protocol (Strategy,
BarsReader, FeatureStore, PortfolioProvider, Optimiser) — concretes are injected at the
composition root, so the driver depends on no volatile concretion.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional

from ..bars.reader import BarsReader
from ..features.contract import FeatureStore
from ..optimise.contract import Optimiser
from ..portfolio.contract import PortfolioProvider
from ..strategy.contract import Strategy, StrategyParams
from ..types import StrategyOutput

# point-in-time universe: observation_ts(ms) -> active tickers at that instant.
UniverseAt = Callable[[int], list[str]]


@dataclass
class ReplayStep:
    observation_ts: int
    output: StrategyOutput
    target_weights: dict[str, float]


@dataclass
class ReplayResult:
    steps: list[ReplayStep] = field(default_factory=list)

    @property
    def weights_series(self) -> list[tuple[int, dict[str, float]]]:
        return [(s.observation_ts, s.target_weights) for s in self.steps]


class Replay:
    def __init__(
        self,
        strategy: Strategy,
        bars: BarsReader,
        store: FeatureStore,
        portfolio: PortfolioProvider,
        optimiser: Optimiser,
    ) -> None:
        self._strategy = strategy
        self._bars = bars
        self._store = store
        self._portfolio = portfolio
        self._optimiser = optimiser

    async def run(
        self,
        lo_ms: int,
        hi_ms: int,
        step_ms: int,
        universe_at: UniverseAt,
        params: Optional[StrategyParams] = None,
        *,
        write_features: bool = True,
    ) -> ReplayResult:
        params = params or StrategyParams(values={})
        # A small margin over rolling_window so strategies that slice [-(window+1):]
        # (sector_momentum) or use a sub-window (topology) still get enough closes.
        lookback = self._strategy.config.rolling_window + 5
        result = ReplayResult()
        current_weights: dict[str, float] = {}

        t = lo_ms
        while t < hi_ms:
            tickers = universe_at(t)
            if tickers:
                history = await self._bars.history_as_of(tickers, t, lookback)
                features = self._strategy.compute_features(history, t, params)
                if features is not None:
                    if write_features:
                        await self._store.write(features, is_replay=True)
                    portfolio = await self._portfolio.at(t)
                    output = self._strategy.decide(features, portfolio)
                    if output is not None:
                        weights = self._optimiser.weights(output, current_weights)
                        result.steps.append(ReplayStep(t, output, weights))
                        current_weights = weights
            t += step_ms
        return result
