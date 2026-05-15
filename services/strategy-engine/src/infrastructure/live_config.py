"""LiveConfig (Python) — async reader for portal_market_config.barFrequency.

Counterpart to services/market-data-service/src/live-config.ts and the new
trading-service/src/infrastructure/live-config.ts. The cached 15s TTL keeps Mongo
load negligible; subscribers to the `config:invalidated` pubsub topic call
`invalidate()` for sub-second propagation after a portal save.

The engine does NOT hot-swap strategies on the fly when bar_frequency changes —
strategy classes capture ROLLING_WINDOW from env at import time and mid-flight
regime / lookback state is too risky to mutate. Instead, main.py compares
get_live_config() against the boot-time value and, on a real change, exits cleanly
so the k8s Deployment restarts the pod with the new env. From the operator's POV
that's a ~10s blip after a portal save with no manual action required.
"""
import asyncio
import os
import time
from dataclasses import dataclass
from typing import Optional

import motor.motor_asyncio


CACHE_TTL_SEC = 15.0


# OrderType enum values mirrored from
# services/trading-service/src/domain/entities/Order.ts. Numeric integers (Limit=0,
# Market=1) — these MUST match. Defined inline because Python can't import TS enums.
ORDER_TYPE_LIMIT = 0
ORDER_TYPE_MARKET = 1


@dataclass
class LiveConfig:
    bar_frequency: str  # 'daily' | 'intraday'
    # signal_order_type is surfaced for /status visibility; strategy-engine itself
    # doesn't consume it. trading-service is the canonical consumer.
    signal_order_type: int  # ORDER_TYPE_LIMIT | ORDER_TYPE_MARKET


_cache: Optional[tuple[LiveConfig, float]] = None
_lock = asyncio.Lock()
_client: Optional[motor.motor_asyncio.AsyncIOMotorClient] = None


def _env_bar_frequency() -> str:
    val = os.environ.get("BAR_FREQUENCY", "daily")
    return "intraday" if val == "intraday" else "daily"


def _env_signal_order_type() -> int:
    val = os.environ.get("SIGNAL_ORDER_TYPE", "Limit")
    if val == "Market" or val == str(ORDER_TYPE_MARKET):
        return ORDER_TYPE_MARKET
    return ORDER_TYPE_LIMIT


def _get_client() -> motor.motor_asyncio.AsyncIOMotorClient:
    global _client
    if _client is None:
        url = os.environ.get("MONGODB_URL", "mongodb://localhost:27017/trader")
        _client = motor.motor_asyncio.AsyncIOMotorClient(url, serverSelectionTimeoutMS=2000)
    return _client


async def get_live_config() -> LiveConfig:
    global _cache
    now = time.monotonic()
    if _cache is not None and now - _cache[1] < CACHE_TTL_SEC:
        return _cache[0]
    async with _lock:
        # Double-check after acquiring the lock — another coroutine may have just refilled.
        if _cache is not None and time.monotonic() - _cache[1] < CACHE_TTL_SEC:
            return _cache[0]
        doc = None
        try:
            db = _get_client().get_default_database()
            doc = await db["portal_market_config"].find_one({"_id": "singleton"})
        except Exception as exc:
            print(f"[strategy-engine:live-config] mongo read failed, using env defaults: {exc!r}")
        bar_frequency = (doc or {}).get("barFrequency") or _env_bar_frequency()
        sot_raw = (doc or {}).get("signalOrderType")
        signal_order_type = (
            sot_raw if sot_raw in (ORDER_TYPE_LIMIT, ORDER_TYPE_MARKET)
            else _env_signal_order_type()
        )
        cfg = LiveConfig(bar_frequency=bar_frequency, signal_order_type=signal_order_type)
        _cache = (cfg, time.monotonic())
        return cfg


def invalidate() -> None:
    global _cache
    _cache = None


def _env_defaults_for_test() -> LiveConfig:
    return LiveConfig(bar_frequency=_env_bar_frequency(), signal_order_type=_env_signal_order_type())
