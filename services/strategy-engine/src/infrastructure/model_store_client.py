"""
Thin MongoDB adapter for persisting neural model versions from strategy-engine.
Mirrors ModelVersionStore in backtest-engine but adds binary blob storage for
model weights and calibrator pickles.
"""
from __future__ import annotations

from datetime import datetime, timezone


class ModelStoreClient:
    def __init__(self, db):
        self._versions = db['model_versions']
        self._blobs    = db['model_blobs']    # GridFS alternative: store bytes directly

    async def save_neural_version(
        self,
        version_id: str,
        strategy_id: str,
        oos_sharpe: float,
        oos_ic: float,
        validation_passed: bool,
        model_bytes: bytes,
        calibrator_bytes: bytes,
        metadata: dict,
    ) -> None:
        now = datetime.now(timezone.utc)
        await self._versions.update_one(
            {'_id': version_id},
            {'$set': {
                '_id':               version_id,
                'strategy_id':       strategy_id,
                'oos_sharpe':        oos_sharpe,
                'oos_ic':            oos_ic,
                'validation_passed': validation_passed,
                'status':            'shadow',
                'shadow_start':      now,
                'promoted_at':       None,
                'metadata':          metadata,
                'created_at':        now,
            }},
            upsert=True,
        )
        # Store model weights separately (can be large)
        await self._blobs.update_one(
            {'version_id': version_id},
            {'$set': {
                'version_id':       version_id,
                'model_bytes':      model_bytes,
                'calibrator_bytes': calibrator_bytes,
                'created_at':       now,
            }},
            upsert=True,
        )

    async def get_live_model_bytes(self, strategy_id: str) -> tuple[bytes, bytes] | None:
        """Returns (model_bytes, calibrator_bytes) for the live version, or None."""
        doc = await self._versions.find_one({'strategy_id': strategy_id, 'status': 'live'})
        if not doc:
            return None
        blob = await self._blobs.find_one({'version_id': doc['_id']})
        if not blob:
            return None
        return blob['model_bytes'], blob['calibrator_bytes']

    async def is_shadow_complete(self, version_id: str, shadow_days: int = 30) -> bool:
        doc = await self._versions.find_one({'_id': version_id})
        if not doc or not doc.get('shadow_start'):
            return False
        elapsed = (datetime.now(timezone.utc) - doc['shadow_start'].replace(tzinfo=timezone.utc)).days
        return elapsed >= shadow_days

    async def promote_to_live(self, version_id: str, strategy_id: str) -> None:
        await self._versions.update_many(
            {'strategy_id': strategy_id, 'status': 'live'},
            {'$set': {'status': 'retired'}},
        )
        await self._versions.update_one(
            {'_id': version_id},
            {'$set': {'status': 'live', 'promoted_at': datetime.now(timezone.utc)}},
        )
