"""Tests for strategy-engine live_config.

Pins:
  - Env fallback (no override doc, no env) → daily / t212.
  - Env-driven defaults pick up BAR_FREQUENCY and EXECUTION_MODE when set.
  - A Mongo override doc beats env per-field.
  - The cache short-circuits repeated reads inside the 15s TTL window.
  - invalidate() forces the next call to re-hit Mongo.
  - A Mongo failure does not crash the call — env fallback kicks in.
"""
from __future__ import annotations

import importlib
import os
import sys
from typing import Any

import pytest


@pytest.fixture
def live_config(monkeypatch):
    """Re-import live_config per-test with a stubbed motor client.

    motor.motor_asyncio.AsyncIOMotorClient is replaced with a fake whose
    .get_default_database()["portal_market_config"].find_one is driven by
    each test's `find_one_impl`.
    """
    # Reset cached module so each test gets a fresh _cache / _client.
    sys.modules.pop("src.infrastructure.live_config", None)

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

    monkeypatch.delenv("BAR_FREQUENCY",      raising=False)
    monkeypatch.delenv("SIGNAL_ORDER_TYPE",  raising=False)

    module = importlib.import_module("src.infrastructure.live_config")
    return module, state


@pytest.mark.asyncio
async def test_env_default_when_doc_missing(live_config):
    mod, state = live_config
    state["find_one_impl"] = lambda: None
    cfg = await mod.get_live_config()
    assert cfg.bar_frequency == "daily"
    assert cfg.signal_order_type == mod.ORDER_TYPE_LIMIT


@pytest.mark.asyncio
async def test_env_override_bar_frequency(live_config, monkeypatch):
    mod, state = live_config
    state["find_one_impl"] = lambda: None
    monkeypatch.setenv("BAR_FREQUENCY",     "intraday")
    monkeypatch.setenv("SIGNAL_ORDER_TYPE", "Market")
    mod.invalidate()
    cfg = await mod.get_live_config()
    assert cfg.bar_frequency == "intraday"
    assert cfg.signal_order_type == mod.ORDER_TYPE_MARKET


@pytest.mark.asyncio
async def test_mongo_override_wins_over_env(live_config, monkeypatch):
    mod, state = live_config
    state["find_one_impl"] = lambda: {
        "_id": "singleton",
        "barFrequency":     "intraday",
        "signalOrderType":  1,  # ORDER_TYPE_MARKET
    }
    monkeypatch.setenv("BAR_FREQUENCY",     "daily")
    monkeypatch.setenv("SIGNAL_ORDER_TYPE", "Limit")
    mod.invalidate()
    cfg = await mod.get_live_config()
    assert cfg.bar_frequency == "intraday"
    assert cfg.signal_order_type == mod.ORDER_TYPE_MARKET


@pytest.mark.asyncio
async def test_per_field_fallback(live_config, monkeypatch):
    """Doc with only one field set should fall back to env for the other."""
    mod, state = live_config
    state["find_one_impl"] = lambda: {
        "_id": "singleton",
        "barFrequency": "intraday",
        # signalOrderType missing
    }
    monkeypatch.setenv("SIGNAL_ORDER_TYPE", "Market")
    mod.invalidate()
    cfg = await mod.get_live_config()
    assert cfg.bar_frequency == "intraday"
    assert cfg.signal_order_type == mod.ORDER_TYPE_MARKET


@pytest.mark.asyncio
async def test_cache_hits_within_ttl(live_config):
    mod, state = live_config
    state["find_one_impl"] = lambda: None
    mod.invalidate()
    await mod.get_live_config()
    await mod.get_live_config()
    await mod.get_live_config()
    # First call hits Mongo; subsequent calls inside the TTL window should not.
    assert state["calls"] == 1


@pytest.mark.asyncio
async def test_invalidate_forces_reread(live_config):
    mod, state = live_config
    state["find_one_impl"] = lambda: None
    mod.invalidate()
    await mod.get_live_config()
    mod.invalidate()
    await mod.get_live_config()
    assert state["calls"] == 2


@pytest.mark.asyncio
async def test_mongo_failure_falls_back_to_env(live_config, monkeypatch):
    mod, state = live_config
    def _boom():
        raise RuntimeError("mongo down")
    state["find_one_impl"] = _boom
    monkeypatch.setenv("BAR_FREQUENCY", "intraday")
    mod.invalidate()
    cfg = await mod.get_live_config()
    # No exception — the call survives a Mongo outage by returning env defaults.
    assert cfg.bar_frequency == "intraday"
