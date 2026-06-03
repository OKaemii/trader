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
from .high_velocity import HighVelocityStrategy
from .collaborators.rebalance_clock import RebalanceClock


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


def _build_high_velocity() -> Strategy:
    # Concentrated monthly momentum + quality: screen (cap ≥ £5B + fail-closed QMJ) → 12-1
    # momentum top-N → drop the highest-vol → inverse-vol weights. Reads the single EODHD-fed
    # universe + the fundamentals the host attaches; the RebalanceClock gates emission to the
    # first session of each calendar month (else it holds).
    top_n  = int(os.getenv('HIGH_VELOCITY_TOP_N_MOMENTUM', '30'))
    drop_n = int(os.getenv('HIGH_VELOCITY_DROP_N_VOL', '10'))
    held_k = max(1, top_n - drop_n)
    config = StrategyConfig(
        strategy_id='high_velocity_v1',
        rolling_window=int(os.getenv('HIGH_VELOCITY_WINDOW', '300')),   # floor: 12-1 needs 252+21
        min_universe_size=5,
        report_cadence=_report_cadence(),
        top_k=int(os.getenv('HIGH_VELOCITY_TOP_K', str(held_k))),
        wants_fundamentals=True,
    )
    return HighVelocityStrategy(
        RebalanceClock(),
        config,
        top_n_momentum=top_n,
        drop_n_vol=drop_n,
        vol_lookback=int(os.getenv('HIGH_VELOCITY_VOL_LOOKBACK', '90')),
        mom_lookback=int(os.getenv('HIGH_VELOCITY_MOM_LOOKBACK', '252')),
        mom_skip=int(os.getenv('HIGH_VELOCITY_MOM_SKIP', '21')),
        min_cap_gbp=float(os.getenv('MIN_MARKET_CAP_GBP', '5000000000')),
    )


_BUILDERS = {
    'factor_rank_v1': _build_factor_rank,
    'sector_momentum_v1': _build_sector_momentum,
    'topology_v1': _build_topology,
    'high_velocity_v1': _build_high_velocity,
}


def make_strategy(strategy_id: str) -> Strategy:
    builder = _BUILDERS.get(strategy_id)
    if builder is None:
        raise ValueError(f'unknown strategy_id: {strategy_id!r} (known: {sorted(_BUILDERS)})')
    return builder()


def known_strategies() -> list[str]:
    return sorted(_BUILDERS)
