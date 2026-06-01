"""resolve_search_grid — portal searchGrid override resolution for the validator.

Pins: override returned as-is, int→float coercion + malformed-entry drop, and the None
fallbacks (no doc / empty grid / no db) that make the caller use parameter_space().
"""
import pytest

from src.infrastructure.strategy_config import resolve_search_grid


class _FakeColl:
    def __init__(self, doc):
        self._doc = doc

    async def find_one(self, _q):
        return self._doc


class _FakeDb:
    def __init__(self, doc):
        self._coll = _FakeColl(doc)

    def __getitem__(self, _name):
        return self._coll


@pytest.mark.asyncio
async def test_grid_override_returned():
    db = _FakeDb({"_id": "factor_rank_v1", "searchGrid": {"w_momentum": [0.5, 1.0, 1.5]}})
    assert await resolve_search_grid(db, "factor_rank_v1") == {"w_momentum": [0.5, 1.0, 1.5]}


@pytest.mark.asyncio
async def test_grid_coerces_and_drops_malformed():
    db = _FakeDb({"searchGrid": {"w_momentum": [1, 2], "bad": "x", "empty": []}})
    assert await resolve_search_grid(db, "factor_rank_v1") == {"w_momentum": [1.0, 2.0]}


@pytest.mark.asyncio
async def test_grid_fallback_none():
    assert await resolve_search_grid(_FakeDb(None), "factor_rank_v1") is None
    assert await resolve_search_grid(_FakeDb({"searchGrid": {}}), "factor_rank_v1") is None
    assert await resolve_search_grid(None, "factor_rank_v1") is None
