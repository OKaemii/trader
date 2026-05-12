from datetime import datetime


class PointInTimeUniverse:
    """Returns active tickers at any historical timestamp — prevents survivorship bias."""

    def __init__(self, db):
        self._db = db

    async def get_active_tickers(self, timestamp_ms: int) -> list[str]:
        ts = datetime.utcfromtimestamp(timestamp_ms / 1000)
        cursor = self._db['instrument_registry'].find({
            'activeFrom': {'$lte': ts},
            '$or': [{'activeTo': None}, {'activeTo': {'$gte': ts}}],
        })
        return [doc['ticker'] async for doc in cursor]
