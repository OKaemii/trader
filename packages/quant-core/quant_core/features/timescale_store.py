"""TimescaleFeatureStore — the bi-temporal FeatureStore implementation (asyncpg).

Mirrors the bar writer's discipline (0002_bars.sql / pg-bar-writer.ts): supersede-then-insert
in one transaction, with a content-hash gate that makes an identical re-compute a no-op. This
is a concrete, volatile dependency — callers depend on the `FeatureStore` Protocol and receive
this only at the composition root (wiring.py).
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import time
from typing import Any, Optional

from ..strategy.contract import FeatureVector

# Fields that define the semantic content of a row (everything except the bi-temporal keys
# observation_ts / knowledge_ts and the strategy_id, which are constant within a logical row).
_HASH_FIELDS = (
    'ticker_universe', 'composite_scores', 'per_ticker', 'cross_sectional_stats',
    'regime_confidence', 'position_size_multiplier', 'signal_weights', 'sectors',
    'covariance_matrix', 'feature_stability', 'extras',
)


def hash_feature_vector(fv: FeatureVector) -> str:
    payload = {k: getattr(fv, k) for k in _HASH_FIELDS}
    canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), default=float)
    return hashlib.sha1(canonical.encode('utf-8')).hexdigest()


def _to_jsonb(fv: FeatureVector) -> str:
    return json.dumps(dataclasses.asdict(fv), separators=(',', ':'), default=float)


def _from_jsonb(raw: Any) -> FeatureVector:
    d = raw if isinstance(raw, dict) else json.loads(raw)
    return FeatureVector(**d)


class TimescaleFeatureStore:
    """Implements the FeatureStore Protocol. `pool` is an asyncpg.Pool (injected)."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def write(self, features: FeatureVector, is_replay: bool) -> None:
        content_hash = hash_feature_vector(features)
        vector_json = _to_jsonb(features)
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                existing = await conn.fetchrow(
                    """SELECT content_hash FROM features
                       WHERE strategy_id=$1 AND observation_ts=$2
                         AND is_superseded=FALSE AND is_replay=$3""",
                    features.strategy_id, features.observation_ts, is_replay,
                )
                # Identical content already live → cosmetic re-compute, no-op.
                if existing is not None and existing['content_hash'] == content_hash:
                    return
                # Genuine revision → supersede the prior live row (atomic with the insert).
                if existing is not None:
                    await conn.execute(
                        """UPDATE features SET is_superseded=TRUE
                           WHERE strategy_id=$1 AND observation_ts=$2
                             AND is_superseded=FALSE AND is_replay=$3""",
                        features.strategy_id, features.observation_ts, is_replay,
                    )
                await conn.execute(
                    """INSERT INTO features
                         (strategy_id, observation_ts, knowledge_ts, feature_vector,
                          ticker_universe, regime_confidence, position_size_multiplier,
                          content_hash, is_superseded, is_replay)
                       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,FALSE,$9)""",
                    features.strategy_id, features.observation_ts, int(time.time() * 1000),
                    vector_json, list(features.ticker_universe), features.regime_confidence,
                    features.position_size_multiplier, content_hash, is_replay,
                )

    async def read_at(
        self, strategy_id: str, as_of_ms: int, is_replay: bool = False
    ) -> Optional[FeatureVector]:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT feature_vector FROM features
                   WHERE strategy_id=$1 AND observation_ts<=$2
                     AND is_superseded=FALSE AND is_replay=$3
                   ORDER BY observation_ts DESC LIMIT 1""",
                strategy_id, as_of_ms, is_replay,
            )
        return _from_jsonb(row['feature_vector']) if row else None

    async def read_window(
        self, strategy_id: str, lo_ms: int, hi_ms: int, is_replay: bool = False
    ) -> list[FeatureVector]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """SELECT feature_vector FROM features
                   WHERE strategy_id=$1 AND observation_ts>=$2 AND observation_ts<=$3
                     AND is_superseded=FALSE AND is_replay=$4
                   ORDER BY observation_ts ASC""",
                strategy_id, lo_ms, hi_ms, is_replay,
            )
        return [_from_jsonb(r['feature_vector']) for r in rows]
