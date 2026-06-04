"""StrategyConfig (Python) — async reader/writer for portal_strategy_config.

Sibling to live_config.py. Per-strategy tunables set from the portal:
  - liveParams: hot-applied — the live host reads them each cycle (15s TTL cache) and passes
    them into compute_features as StrategyParams, so a portal save takes effect on the next
    cycle with no restart;
  - searchGrid: consumed by the backtest validator (see backtest-engine's strategy_config.py).

get_live_params falls back to {} (⇒ the strategy's code defaults via StrategyParams.get) on any
miss or Mongo error — a portal/Mongo blip must never break signal generation.
"""
import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Optional

import motor.motor_asyncio

CACHE_TTL_SEC = 15.0
COLLECTION = "portal_strategy_config"

_cache: dict[str, tuple[dict, float]] = {}
_active_cache: Optional[tuple[Optional[str], float]] = None   # (strategyId|None, monotonic stamp)
_lock = asyncio.Lock()
_client: Optional[motor.motor_asyncio.AsyncIOMotorClient] = None


def _db():
    global _client
    if _client is None:
        url = os.environ.get("MONGODB_URL", "mongodb://localhost:27017/trader")
        _client = motor.motor_asyncio.AsyncIOMotorClient(url, serverSelectionTimeoutMS=2000)
    return _client.get_default_database()


def _coerce_floats(raw) -> dict[str, float]:
    out: dict[str, float] = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            try:
                out[str(k)] = float(v)
            except (TypeError, ValueError):
                continue
    return out


async def get_live_params(strategy_id: str) -> dict[str, float]:
    """The portal liveParams override for `strategy_id`, cached 15s. {} ⇒ code defaults."""
    now = time.monotonic()
    cached = _cache.get(strategy_id)
    if cached is not None and now - cached[1] < CACHE_TTL_SEC:
        return cached[0]
    async with _lock:
        cached = _cache.get(strategy_id)
        if cached is not None and time.monotonic() - cached[1] < CACHE_TTL_SEC:
            return cached[0]
        params: dict[str, float] = {}
        try:
            doc = await _db()[COLLECTION].find_one({"_id": strategy_id})
            params = _coerce_floats((doc or {}).get("liveParams"))
        except Exception as exc:   # noqa: BLE001 — never break the cycle on a Mongo blip
            print(f"[strategy-engine:strategy-config] mongo read failed, using defaults: {exc!r}")
        _cache[strategy_id] = (params, time.monotonic())
        return params


async def get_strategy_config_doc(strategy_id: str) -> Optional[dict]:
    """Raw override doc (liveParams + searchGrid + updatedAt) for the portal GET — uncached."""
    try:
        return await _db()[COLLECTION].find_one({"_id": strategy_id})
    except Exception as exc:   # noqa: BLE001
        print(f"[strategy-engine:strategy-config] doc read failed: {exc!r}")
        return None


async def upsert_strategy_config(
    strategy_id: str,
    live_params: Optional[dict],
    search_grid: Optional[dict],
    updated_by: str,
) -> None:
    await _db()[COLLECTION].update_one(
        {"_id": strategy_id},
        {"$set": {"liveParams": live_params, "searchGrid": search_grid,
                  "updatedBy": updated_by, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    invalidate()


def invalidate() -> None:
    global _active_cache
    _cache.clear()
    _active_cache = None


# ── Active-strategy selection (portal dropdown) ──────────────────────────────────
# Stored in PORTAL_RUNTIME_CONFIG ({_id:'active_strategy', strategyId}). Read once at host
# startup to override the ACTIVE_STRATEGY env default; the PUT persists the operator's choice.
# Applies on the next strategy-engine restart (selection is structural — it changes the universe
# source, rolling window, and cross-cycle state).
RUNTIME_COLLECTION = "portal_runtime_config"
ACTIVE_STRATEGY_ID = "active_strategy"


async def get_active_strategy(use_cache: bool = False) -> Optional[str]:
    """Portal-selected active strategy. `use_cache=True` returns the 15s-cached value — used by the
    live host's per-cycle hot-swap check so it doesn't hit Mongo every cycle; the startup read and
    the PUT path call it fresh."""
    global _active_cache
    if use_cache and _active_cache is not None and time.monotonic() - _active_cache[1] < CACHE_TTL_SEC:
        return _active_cache[0]
    try:
        doc = await _db()[RUNTIME_COLLECTION].find_one({"_id": ACTIVE_STRATEGY_ID})
        sid = (doc or {}).get("strategyId")
        val = str(sid) if sid else None
    except Exception as exc:   # noqa: BLE001 — fall back to the last good / env default on any miss/blip
        print(f"[strategy-engine:strategy-config] active-strategy read failed: {exc!r}")
        return _active_cache[0] if _active_cache is not None else None
    _active_cache = (val, time.monotonic())
    return val


async def set_active_strategy(strategy_id: str, updated_by: str) -> None:
    await _db()[RUNTIME_COLLECTION].update_one(
        {"_id": ACTIVE_STRATEGY_ID},
        {"$set": {"strategyId": strategy_id, "updatedBy": updated_by, "updatedAt": datetime.now(timezone.utc)}},
        upsert=True,
    )
    invalidate()   # drop the cached active-strategy so the per-cycle check sees the new value at once
