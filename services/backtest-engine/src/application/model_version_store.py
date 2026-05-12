from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


RETRAINING_POLICY = {
    'retrain_frequency_days':  90,    # retrain quarterly — slow by design
    'rolling_window_days':    365,    # use last 12 months of data for stability
    'min_training_samples':   500,    # refuse to train on < 500 samples
    'max_staleness_days':     120,    # after 120 days without retraining, confidence → 0
    'shadow_test_days':        30,    # minimum shadow period before promotion
    'drift_trigger_enabled':  True,   # DriftMonitor can trigger early retraining if IC collapses
}


@dataclass
class ModelVersion:
    version_id: str
    strategy_id: str
    train_start: datetime
    train_end: datetime
    oos_sharpe: float
    oos_ic: float
    validation_passed: bool
    shadow_start: datetime | None
    promoted_at: datetime | None
    status: str  # 'shadow' | 'live' | 'retired' | 'failed'
    metadata: dict


class ModelVersionStore:
    def __init__(self, db):
        self._col = db['model_versions']

    async def save(self, version: ModelVersion) -> None:
        doc = {
            '_id':               version.version_id,
            'strategy_id':       version.strategy_id,
            'train_start':       version.train_start,
            'train_end':         version.train_end,
            'oos_sharpe':        version.oos_sharpe,
            'oos_ic':            version.oos_ic,
            'validation_passed': version.validation_passed,
            'shadow_start':      version.shadow_start,
            'promoted_at':       version.promoted_at,
            'status':            version.status,
            'metadata':          version.metadata,
            'created_at':        datetime.now(timezone.utc),
        }
        await self._col.update_one({'_id': version.version_id}, {'$set': doc}, upsert=True)

    async def get_live(self, strategy_id: str) -> ModelVersion | None:
        doc = await self._col.find_one({'strategy_id': strategy_id, 'status': 'live'})
        return self._from_doc(doc) if doc else None

    async def promote_to_live(self, version_id: str, strategy_id: str) -> None:
        """Retire current live version, promote shadow to live."""
        await self._col.update_many(
            {'strategy_id': strategy_id, 'status': 'live'},
            {'$set': {'status': 'retired'}},
        )
        await self._col.update_one(
            {'_id': version_id},
            {'$set': {'status': 'live', 'promoted_at': datetime.now(timezone.utc)}},
        )

    async def is_shadow_complete(self, version_id: str) -> bool:
        doc = await self._col.find_one({'_id': version_id})
        if not doc or not doc.get('shadow_start'):
            return False
        days = (datetime.now(timezone.utc) - doc['shadow_start'].replace(tzinfo=timezone.utc)).days
        return days >= RETRAINING_POLICY['shadow_test_days']

    def _from_doc(self, doc: dict) -> ModelVersion:
        return ModelVersion(
            version_id=doc['_id'],
            strategy_id=doc['strategy_id'],
            train_start=doc['train_start'],
            train_end=doc['train_end'],
            oos_sharpe=doc['oos_sharpe'],
            oos_ic=doc['oos_ic'],
            validation_passed=doc['validation_passed'],
            shadow_start=doc.get('shadow_start'),
            promoted_at=doc.get('promoted_at'),
            status=doc['status'],
            metadata=doc.get('metadata', {}),
        )
