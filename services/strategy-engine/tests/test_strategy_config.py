"""Tests for strategy-engine strategy_config (portal_strategy_config live-param reader).

Pins: liveParams read + float coercion, {} fallback on a missing doc, 15s cache short-circuit,
invalidate() forcing a re-read, and Mongo-failure safety (never break the cycle).
"""
from __future__ import annotations

import importlib
import sys
from typing import Any

import pytest


@pytest.fixture
def strategy_config(monkeypatch):
    """Re-import strategy_config per-test with a stubbed motor client (mirrors test_live_config)."""
    sys.modules.pop("src.infrastructure.strategy_config", None)
    state: dict[str, Any] = {"find_one_impl": lambda: None, "calls": 0}

    class FakeColl:
        async def find_one(self, _q):
            state["calls"] += 1
            return state["find_one_impl"]()

    class FakeDb:
        def __getitem__(self, _name):
            return FakeColl()

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        def get_default_database(self):
            return FakeDb()

    import motor.motor_asyncio
    monkeypatch.setattr(motor.motor_asyncio, "AsyncIOMotorClient", FakeClient)

    module = importlib.import_module("src.infrastructure.strategy_config")
    return module, state


@pytest.mark.asyncio
async def test_live_params_read_and_coerced(strategy_config):
    mod, state = strategy_config
    state["find_one_impl"] = lambda: {"_id": "factor_rank_v1", "liveParams": {"w_momentum": 1.5, "mom_lookback": 126}}
    mod.invalidate()
    assert await mod.get_live_params("factor_rank_v1") == {"w_momentum": 1.5, "mom_lookback": 126.0}


@pytest.mark.asyncio
async def test_missing_doc_returns_empty(strategy_config):
    mod, state = strategy_config
    state["find_one_impl"] = lambda: None
    mod.invalidate()
    assert await mod.get_live_params("factor_rank_v1") == {}


@pytest.mark.asyncio
async def test_cache_then_invalidate(strategy_config):
    mod, state = strategy_config
    state["find_one_impl"] = lambda: {"liveParams": {"w_momentum": 1.0}}
    mod.invalidate()
    await mod.get_live_params("X")
    await mod.get_live_params("X")
    assert state["calls"] == 1            # cached within the 15s TTL
    mod.invalidate()
    await mod.get_live_params("X")
    assert state["calls"] == 2            # re-read after invalidate()


@pytest.mark.asyncio
async def test_mongo_failure_returns_empty(strategy_config):
    mod, state = strategy_config

    def _boom():
        raise RuntimeError("mongo down")

    state["find_one_impl"] = _boom
    mod.invalidate()
    assert await mod.get_live_params("factor_rank_v1") == {}   # survives a Mongo outage
