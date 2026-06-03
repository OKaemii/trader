"""
Market-data client: fetches downsampled bar history from market-data-service.

Replaces the previous per-arrival accumulation pattern (where each strategy built
its rolling window from xreadgroup'd bars). Mongo via shared-bars is the source of
truth; strategy-engine becomes stateless across restarts.

Auth: HS256 JWT signed with JWT_SECRET (shared via trader-secrets across services).
Mirrors `packages/shared-auth/src/internal-jwt.ts` (mintInternalJwt) — same shape,
same secret, same claims:
    header  : {"alg":"HS256","typ":"JWT"}
    payload : {"sub":"strategy-engine","aud":"internal","iat":<now>,"exp":<now+300s>}
Sent as `Authorization: Bearer <jwt>`. Server side runs parseInternalHeaders, which
uses jose's jwtVerify against the same JWT_SECRET and enforces aud=internal +
sub ∈ allowedCallers.

Cache: per-process dict, keyed by (ticker, interval, range, cycle_id). Strategy-engine
invokes `start_cycle(cycle_id)` once per `process_loop` iteration and the cache is scoped
to that cycle — subsequent fetches within the same cycle for the same ticker hit memory.
Cross-cycle, we trust the HTTP layer's read-through Redis cache (1h TTL) to keep
latency bounded.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

# Single source of truth for internal-JWT minting (mirrors shared-auth/internal-jwt.ts).
from quant_core.http.internal_jwt import mint_internal_jwt

from ..domain.dataclasses import OHLCVBar


CALLER = "strategy-engine"
DEFAULT_TIMEOUT_SECONDS = 10.0

# Range keys the internal bars endpoint serves, as (calendar-day cap, key). Mirrors
# quant_core.bars.live_reader._RANGE_LADDER — the long keys read the persisted daily series,
# so a deep lookback (e.g. 12-1 momentum) is no longer capped at 180d.
_RANGE_LADDER = [(30, "30d"), (60, "60d"), (90, "90d"), (180, "180d"),
                 (365, "1y"), (730, "2y"), (1825, "5y")]


def range_for_bars(lookback_bars: int) -> str:
    """Smallest range key whose calendar window covers `lookback_bars` TRADING bars
    (~252/yr ⇒ ×1.5 headroom for weekends + holidays). Used by the live host to size the
    daily fetch to the configured momentum lookback."""
    calendar_days = int(max(1, lookback_bars) * 1.5) + 5
    for cap, key in _RANGE_LADDER:
        if calendar_days <= cap:
            return key
    return "max"


class MarketDataClient:
    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = (base_url or os.getenv("MARKET_DATA_SERVICE_URL")
                          or "http://market-data-service:3002").rstrip("/")
        # JWT_SECRET is the shared HS256 secret — same env var as the Node services'
        # mintInternalJwt(). Falls back to the dev sentinel if unset, but parseInternalHeaders
        # on the server side will reject any token signed with the sentinel in prod.
        self._secret = secret or os.getenv("JWT_SECRET", "dev-secret-change-me")
        self._timeout = timeout
        # Per-cycle in-memory cache. Cleared on start_cycle. Keyed by (ticker, interval,
        # range, as_of_ms) so live and as-of reads in the same cycle don't collide.
        self._cycle_id: str | None = None
        self._cache: dict[tuple[str, str, str, int | None], list[OHLCVBar]] = {}

    def start_cycle(self, cycle_id: str) -> None:
        """Reset the per-cycle cache. Call once per process_loop iteration."""
        self._cycle_id = cycle_id
        self._cache.clear()

    def _auth_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {mint_internal_jwt(CALLER, self._secret)}"}

    async def fetch_bars(
        self,
        ticker: str,
        interval: str = "daily",
        range_key: str = "30d",
        *,
        as_of_ms: int | None = None,
    ) -> list[OHLCVBar]:
        """
        Single-ticker fetch. Use fetch_bars_batch when you have multiple.

        Bi-temporal: pass `as_of_ms` (UTC ms knowledge-time cutoff) to read the bars
        as known at that wall-clock instant. Omitting it returns the latest
        unsuperseded revisions — the default "as of now" behaviour. Required for
        backtest replay; live cycles leave it unset.
        See agent-docs/plans/point-in-time-bar-history.md.
        """
        key = (ticker, interval, range_key, as_of_ms)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        url = f"{self._base_url}/internal/api/market-data/bars/{ticker}?interval={interval}&range={range_key}"
        if as_of_ms is not None:
            url += f"&asOf={as_of_ms}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.get(url, headers=self._auth_header())
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
        *,
        as_of_ms: int | None = None,
    ) -> dict[str, list[OHLCVBar]]:
        """
        Fetch multiple tickers in one HTTP round-trip. Critical for the warmup
        hydration path where the universe is ~200 tickers — one round-trip beats 200.
        Honours the per-cycle cache: tickers already in the cache are returned from
        memory and only the misses go over the wire.

        Bi-temporal: pass `as_of_ms` to read what was known at that knowledge time
        across the whole batch. See `fetch_bars` for details.
        """
        out: dict[str, list[OHLCVBar]] = {}
        misses: list[str] = []
        for t in tickers:
            cached = self._cache.get((t, interval, range_key, as_of_ms))
            if cached is not None:
                out[t] = cached
            else:
                misses.append(t)

        if not misses:
            return out

        url = f"{self._base_url}/internal/api/market-data/bars"
        body: dict[str, object] = {"tickers": misses, "interval": interval, "range": range_key}
        if as_of_ms is not None:
            body["asOf"] = as_of_ms
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(
                url,
                headers={**self._auth_header(), "Content-Type": "application/json"},
                json=body,
            )
            r.raise_for_status()
            payload = r.json()
        for t, raw_bars in (payload.get("bars") or {}).items():
            bars = [self._bar_from_dict(b) for b in raw_bars]
            self._cache[(t, interval, range_key, as_of_ms)] = bars
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

    async def fetch_sectors(self) -> dict[str, str]:
        """
        Hit market-data-service's /internal/api/universe/sectors endpoint and return
        the ticker → GICS-sector map for the current active universe.

        Server-side, market-data-service reads its `_sectorMap` (read-through cached
        in Mongo `instrument_metadata`, refreshed from Yahoo on universe rebuild).
        Tickers without a Mongo row come back as 'Unknown' — strategies can rely on
        every active-universe ticker being present in the returned dict.

        Failures (HTTP error, JSON parse) raise; the engine host catches and keeps
        the stale `_strategy._sectors` so an upstream blip doesn't degrade the cycle.
        """
        url = f"{self._base_url}/internal/api/universe/sectors"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.get(url, headers=self._auth_header())
            r.raise_for_status()
            payload = r.json()
        sectors = payload.get("sectors") or {}
        # Defensive copy — caller is expected to do `self._sectors.update(returned)`,
        # and we don't want a downstream mutation of the dict to leak back into the
        # next call's response.
        return dict(sectors)

    async def fetch_fundamentals(self, tickers: list[str]) -> dict[str, dict[str, float]]:
        """Per-ticker QMJ line items from market-data /internal/api/fundamentals, mapped to the
        quant-core HistoryView.fundamentals shape (snake_case). The host attaches this for
        quality-screening strategies (high_velocity_v1); fail-closed downstream on missing names."""
        if not tickers:
            return {}
        url = f"{self._base_url}/internal/api/fundamentals?tickers={','.join(tickers)}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.get(url, headers=self._auth_header())
            r.raise_for_status()
            payload = r.json()
        out: dict[str, dict[str, float]] = {}
        for t, d in (payload.get("fundamentals") or {}).items():
            raw = d.get("raw") or {}
            out[t] = {
                "market_cap_gbp":      float(d.get("marketCapGbp") or 0.0),
                "net_income":          float(raw.get("netIncome") or 0.0),
                "total_equity":        float(raw.get("totalEquity") or 0.0),
                "total_debt":          float(raw.get("totalDebt") or 0.0),
                "current_assets":      float(raw.get("currentAssets") or 0.0),
                "current_liabilities": float(raw.get("currentLiabilities") or 0.0),
            }
        return out
