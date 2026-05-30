"""NullFeatureStore — a no-op FeatureStore for replays that don't persist (write_features=False)
and for unit tests. Satisfies the FeatureStore Protocol without a database."""
from __future__ import annotations

from typing import Optional

from ..strategy.contract import FeatureVector


class NullFeatureStore:
    async def write(self, features: FeatureVector, is_replay: bool) -> None:
        return None

    async def read_at(self, strategy_id: str, as_of_ms: int, is_replay: bool = False) -> Optional[FeatureVector]:
        return None

    async def read_window(self, strategy_id: str, lo_ms: int, hi_ms: int, is_replay: bool = False) -> list[FeatureVector]:
        return []
