"""Composition root — the ONE place concrete collaborators are instantiated and injected.

Everything below depends on abstractions (Strategy, BarsReader, FeatureStore,
PortfolioProvider, Optimiser); only this module names the concretions. Hosts call
`build_replay(...)` and receive a fully wired `Replay` without learning any concrete type.
"""
from __future__ import annotations

from typing import Optional

from .bars.reader import BarsReader, make_bars_reader
from .features.contract import FeatureStore
from .features.null_store import NullFeatureStore
from .optimise.long_only import LongOnlyOptimiser
from .portfolio.providers import EmptyPortfolioProvider
from .replay.driver import Replay
from .strategy.factory import make_strategy


def build_feature_store(pg_pool) -> FeatureStore:
    """TimescaleFeatureStore when a pool is supplied, else a no-op store."""
    if pg_pool is None:
        return NullFeatureStore()
    from .features.timescale_store import TimescaleFeatureStore
    return TimescaleFeatureStore(pg_pool)


def build_replay(
    strategy_id: str,
    *,
    bars_source: str = "live",
    bars: Optional[BarsReader] = None,
    pg_pool=None,
    persist_features: bool = False,
    bars_kwargs: Optional[dict] = None,
) -> Replay:
    """Wire a fresh strategy + collaborators into a Replay.

    `bars` lets a caller inject a *pre-built* reader rather than constructing one from
    `bars_source`. The backtest uses this to share a single Yahoo reader whose cache is warmed
    once up front across the many fresh-strategy replays a walk-forward grid search runs — each
    call still gets a fresh strategy instance (no cross-run state bleed) but reuses the warm
    cache (no re-fetch)."""
    strategy = make_strategy(strategy_id)
    reader = bars if bars is not None else make_bars_reader(bars_source, **(bars_kwargs or {}))
    store = build_feature_store(pg_pool if persist_features else None)
    return Replay(
        strategy=strategy,
        bars=reader,
        store=store,
        portfolio=EmptyPortfolioProvider(),
        optimiser=LongOnlyOptimiser(),
    )
