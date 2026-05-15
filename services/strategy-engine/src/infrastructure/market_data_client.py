"""
Market-data client: fetches downsampled bar history from market-data-service.

Replaces the previous per-arrival accumulation pattern (where each strategy built
its rolling window from xreadgroup'd bars). Mongo via shared-bars is the source of
truth; strategy-engine becomes stateless across restarts.

Auth: HMAC-SHA256 over "<caller>:<ts>", matching packages/shared-auth/src/internal-token.ts.
Token shape: "<unix_ms>.<hex_hmac>". Validated server-side against the trading-service
INTERNAL_SECRET env var, which both services share.

Cache: per-process dict, keyed by (ticker, interval, range, cycle_id). Strategy-engine
invokes `start_cycle(cycle_id)` once per `process_loop` iteration and the cache is scoped
to that cycle — subsequent fetches within the same cycle for the same ticker hit memory.
Cross-cycle, we trust the HTTP layer's read-through Redis cache (1h TTL) to keep
latency bounded.
"""

from __future__ import annotations

import hmac
import hashlib
import os
import time
from typing import Any

import httpx

from ..domain.dataclasses import OHLCVBar


CALLER = "strategy-engine"
DEFAULT_TIMEOUT_SECONDS = 10.0


class MarketDataClient:
    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = (base_url or os.getenv("MARKET_DATA_SERVICE_URL")
                          or "http://market-data-service:3002").rstrip("/")
        self._secret = secret or os.getenv("INTERNAL_SECRET", "dev-internal-secret-change-me")
        self._timeout = timeout
        # Per-cycle in-memory cache. Cleared on start_cycle.
        self._cycle_id: str | None = None
        self._cache: dict[tuple[str, str, str], list[OHLCVBar]] = {}

    def start_cycle(self, cycle_id: str) -> None:
        """Reset the per-cycle cache. Call once per process_loop iteration."""
        self._cycle_id = cycle_id
        self._cache.clear()

    def _token(self) -> str:
        ts = str(int(time.time() * 1000))
        mac = hmac.new(self._secret.encode(), f"{CALLER}:{ts}".encode(), hashlib.sha256).hexdigest()
        return f"{ts}.{mac}"

    async def fetch_bars(
        self,
        ticker: str,
        interval: str = "daily",
        range_key: str = "30d",
    ) -> list[OHLCVBar]:
        """Single-ticker fetch. Use fetch_bars_batch when you have multiple."""
        key = (ticker, interval, range_key)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        url = f"{self._base_url}/internal/bars/{ticker}?interval={interval}&range={range_key}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.get(url, headers={"X-Internal-Token": self._token()})
            r.raise_for_status()
            payload = r.json()
        bars = [self._bar_from_dict(b) for b in payload.get("bars", [])]
        self._cache[key] = bars
        return bars

    async def fetch_bars_batch(
        self,
        tickers: list[str],
        interval: str = "daily",
        range_key: str = "30d",
    ) -> dict[str, list[OHLCVBar]]:
        """
        Fetch multiple tickers in one HTTP round-trip. Critical for the warmup
        hydration path where the universe is ~200 tickers — one round-trip beats 200.
        Honours the per-cycle cache: tickers already in the cache are returned from
        memory and only the misses go over the wire.
        """
        out: dict[str, list[OHLCVBar]] = {}
        misses: list[str] = []
        for t in tickers:
            cached = self._cache.get((t, interval, range_key))
            if cached is not None:
                out[t] = cached
            else:
                misses.append(t)

        if not misses:
            return out

        url = f"{self._base_url}/internal/bars"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(
                url,
                headers={"X-Internal-Token": self._token(), "Content-Type": "application/json"},
                json={"tickers": misses, "interval": interval, "range": range_key},
            )
            r.raise_for_status()
            payload = r.json()
        for t, raw_bars in (payload.get("bars") or {}).items():
            bars = [self._bar_from_dict(b) for b in raw_bars]
            self._cache[(t, interval, range_key)] = bars
            out[t] = bars
        # Tickers not returned (provider unresolvable etc.) are absent from out — that's
        # intentional. Callers should treat missing as "not enough data" rather than empty.
        return out

    @staticmethod
    def _bar_from_dict(d: dict[str, Any]) -> OHLCVBar:
        return OHLCVBar(
            ticker=d["ticker"],
            timestamp=int(d["timestamp"]),
            open=float(d["open"]),
            high=float(d["high"]),
            low=float(d["low"]),
            close=float(d["close"]),
            volume=float(d.get("volume") or 0),
        )
