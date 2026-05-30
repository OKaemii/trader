"""FeatureStore abstraction — the bi-temporal persistence seam for FeatureVectors.

Replay and the live host depend on this Protocol, never on a concrete store. The Timescale
implementation (`timescale_store.py`) is wired in at the composition root (Phase 1). Storage
is demonstrably volatile (the platform just migrated Mongo→Timescale), so this indirection is
exactly the volatile-concretion isolation the architecture contract requires.
"""
from __future__ import annotations

from typing import Optional, Protocol

from ..strategy.contract import FeatureVector


class FeatureStore(Protocol):
    async def write(self, features: FeatureVector, is_replay: bool) -> None:
        """Bi-temporal supersede-then-insert. Identical content (by hash) is a no-op."""
        ...

    async def read_at(self, strategy_id: str, as_of_ms: int, is_replay: bool = False) -> Optional[FeatureVector]:
        """Latest revision known at `as_of_ms` (knowledge-time). None if none exists."""
        ...

    async def read_window(
        self, strategy_id: str, lo_ms: int, hi_ms: int, is_replay: bool = False
    ) -> list[FeatureVector]:
        """All live (unsuperseded) feature rows with observation_ts in [lo, hi], oldest first.

        Backs the stateless RegimeEngine / FeatureStabilityAnalyser window reads (Phase 1).
        """
        ...
