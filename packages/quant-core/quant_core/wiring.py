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
from .optimise.inverse_vol import InverseVolOptimiser
from .portfolio.providers import EmptyPortfolioProvider
from .replay.driver import Replay
from .strategy.factory import make_strategy


def build_feature_store(pg_pool) -> FeatureStore:
    """TimescaleFeatureStore when a pool is supplied, else a no-op store."""
    if pg_pool is None:
        return NullFeatureStore()
    from .features.timescale_store import TimescaleFeatureStore
    return TimescaleFeatureStore(pg_pool)


# Strategies whose decide() emits weighting='inverse_vol' — sized by the InverseVolOptimiser
# instead of solve_long_only. Selection lives here (the composition root), not in any host.
INVERSE_VOL_STRATEGIES = {"high_velocity_v1"}

# Optional fundamentals snapshot attached to every replay HistoryView for quality-screening
# strategies. Set in the main process before a backtest AND in each MCPT worker via the pool
# initializer (spawn-safe — the snapshot is a plain picklable dict). None ⇒ bars-only (the
# fail-closed QMJ screen then emits nothing — the honest "no fundamentals" result).
_REPLAY_FUNDAMENTALS: Optional[dict] = None


def set_replay_fundamentals(snapshot: Optional[dict]) -> None:
    global _REPLAY_FUNDAMENTALS
    _REPLAY_FUNDAMENTALS = snapshot


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
    # Attach the fundamentals snapshot (if set) so quality-screening strategies can run in replay.
    if _REPLAY_FUNDAMENTALS:
        from .bars.fundamentals_reader import FundamentalsBarsReader
        reader = FundamentalsBarsReader(reader, _REPLAY_FUNDAMENTALS)
    store = build_feature_store(pg_pool if persist_features else None)
    optimiser = InverseVolOptimiser() if strategy_id in INVERSE_VOL_STRATEGIES else LongOnlyOptimiser()
    return Replay(
        strategy=strategy,
        bars=reader,
        store=store,
        portfolio=EmptyPortfolioProvider(),
        optimiser=optimiser,
    )
