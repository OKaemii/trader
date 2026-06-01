"""StrategyFactory — the ONLY place concrete strategy and factor classes are named.

Hosts (strategy-engine live loop, backtest-engine replay) depend on the `Strategy` Protocol
and call `make_strategy(strategy_id)`; they never import a concrete strategy. This is the
Abstract Factory that isolates the volatile concretions behind the stable abstraction.
"""
from __future__ import annotations

import os

from .contract import Strategy, StrategyConfig
from .factors import CompositeFactor, LowVolFactor, MomentumFactor, ReversalFactor
from .collaborators.regime_engine import RegimeEngine
from .collaborators.feature_stability import FeatureStabilityAnalyser
from .collaborators.trend_filter import TrendFilter
from .factor_rank import FactorRankStrategy
from .sector_momentum import SectorMomentumStrategy
from .topology import TopologyStrategy


def _bar_frequency() -> str:
    return os.getenv('BAR_FREQUENCY', 'daily')


def _report_cadence() -> str:
    # Daily rebalance → one email per cycle. Intraday (5m) → hourly digest.
    return 'per_cycle' if _bar_frequency() == 'daily' else 'hourly'


def _factor_rank_window() -> int:
    # BAR_FREQUENCY=daily → 300 trading days: a floor that covers 12-1 momentum (252 lookback +
    # 21 skip) with headroom, fed by the persisted long-range daily series. Intraday → 60 bars
    # (shorter horizon; the momentum lookback clamps to what's available).
    default = '300' if _bar_frequency() == 'daily' else '60'
    return int(os.getenv('ROLLING_WINDOW_BARS', default))


def _build_factor_rank() -> Strategy:
    # Momentum-led blend; reversal kept at weight 0 (tunable — it was part of the original
    # research) so it no longer cancels the re-horizoned momentum. TrendFilter adds the
    # absolute-momentum / breadth defensive overlay.
    factor = CompositeFactor(
        [MomentumFactor(), LowVolFactor(), ReversalFactor()],
        weights={'momentum': 1.0, 'low_vol': 0.5, 'reversal': 0.0},
    )
    config = StrategyConfig(
        strategy_id='factor_rank_v1',
        rolling_window=_factor_rank_window(),
        min_universe_size=5,
        report_cadence=_report_cadence(),
        top_k=int(os.getenv('FACTOR_RANK_TOP_K', '20')),
        # Match RegimeEngine.HISTORY_MIN * 2 so regime + stability reach steady state by
        # cycle 1 (preserves the legacy factor_rank prewarm depth of 126).
        prewarm_cycles=RegimeEngine.HISTORY_MIN * 2,
    )
    return FactorRankStrategy(factor, RegimeEngine(), FeatureStabilityAnalyser(), TrendFilter(), config)


def _build_sector_momentum() -> Strategy:
    config = StrategyConfig(
        strategy_id='sector_momentum_v1',
        rolling_window=20,
        min_universe_size=5,
        report_cadence=_report_cadence(),
        top_k=int(os.getenv('SECTOR_MOMENTUM_TOP_K', '12')),
    )
    return SectorMomentumStrategy(RegimeEngine(), config)


def _build_topology() -> Strategy:
    config = StrategyConfig(
        strategy_id='topology_v1',
        rolling_window=30,        # MIN_HISTORY — host fetches this many bars
        min_universe_size=10,
        report_cadence=_report_cadence(),
        top_k=int(os.getenv('TOPOLOGY_TOP_K', '15')),
    )
    return TopologyStrategy(RegimeEngine(), config)


_BUILDERS = {
    'factor_rank_v1': _build_factor_rank,
    'sector_momentum_v1': _build_sector_momentum,
    'topology_v1': _build_topology,
}


def make_strategy(strategy_id: str) -> Strategy:
    builder = _BUILDERS.get(strategy_id)
    if builder is None:
        raise ValueError(f'unknown strategy_id: {strategy_id!r} (known: {sorted(_BUILDERS)})')
    return builder()


def known_strategies() -> list[str]:
    return sorted(_BUILDERS)
