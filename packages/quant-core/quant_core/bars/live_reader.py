"""LiveBarsReader — reads daily bars over HTTP from market-data-service (asOf-aware).

Used by the backtest replay to drive compute_features over historical windows without a
direct DB/Yahoo dependency (market-data-service owns the source + cache). Mints the shared
internal JWT (caller='backtest-engine'). httpx is an optional extra; imported lazily.
"""
from __future__ import annotations

import os
from typing import Optional

from ..http.internal_jwt import mint_internal_jwt
from ..strategy.contract import HistoryView
from ..types import OHLCVBar

# Range keys the internal bars endpoint serves. Long-range daily keys (1y/2y/5y/max) are
# added in Phase 3 (market-data-service fetchDailyHistory); until then daily history is
# capped at 180d, which bounds how far back a replay can reach.
_RANGE_LADDER = [(30, "30d"), (60, "60d"), (90, "90d"), (180, "180d")]


def _range_for(lookback_bars: int) -> str:
    for cap, key in _RANGE_LADDER:
        if lookback_bars <= cap:
            return key
    return "180d"


class LiveBarsReader:
    def __init__(
        self,
        base_url: Optional[str] = None,
        secret: Optional[str] = None,
        caller: str = "backtest-engine",
        timeout: float = 30.0,
    ) -> None:
        self._base_url = (base_url or os.getenv("MARKET_DATA_SERVICE_URL")
                          or "http://market-data-service:3002").rstrip("/")
        self._secret = secret or os.getenv("JWT_SECRET", "dev-secret-change-me")
        self._caller = caller
        self._timeout = timeout

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {mint_internal_jwt(self._caller, self._secret)}"}

    async def history_as_of(
        self, tickers: list[str], as_of_ms: int, lookback_bars: int
    ) -> HistoryView:
        import httpx

        url = f"{self._base_url}/internal/api/market-data/bars"
        body = {"tickers": tickers, "interval": "daily",
                "range": _range_for(lookback_bars), "asOf": as_of_ms}
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.post(url, headers={**self._auth(), "Content-Type": "application/json"}, json=body)
            r.raise_for_status()
            payload = r.json()

        closes: dict[str, list[float]] = {}
        volumes: dict[str, list[float]] = {}
        timestamps: dict[str, list[int]] = {}
        for ticker, raw in (payload.get("bars") or {}).items():
            # No lookahead: keep only bars at/under the rebalance instant, oldest-first,
            # then the last `lookback_bars`.
            bars = sorted(
                (b for b in raw if int(b["timestamp"]) <= as_of_ms),
                key=lambda b: int(b["timestamp"]),
            )[-lookback_bars:]
            if not bars:
                continue
            closes[ticker] = [float(b["close"]) for b in bars]
            volumes[ticker] = [float(b.get("volume") or 0) for b in bars]
            timestamps[ticker] = [int(b["timestamp"]) for b in bars]
        return HistoryView(closes=closes, volumes=volumes, timestamps=timestamps)

    async def daily_bars(
        self, ticker: str, start_ms: int, end_ms: Optional[int] = None
    ) -> list[OHLCVBar]:
        import httpx

        # NOTE: bounded by the 180d ladder until Phase 3 adds long-range daily keys; a
        # multi-year backtest needs that extension to reach `start_ms` fully.
        url = (f"{self._base_url}/internal/api/market-data/bars/{ticker}"
               f"?interval=daily&range=180d")
        if end_ms is not None:
            url += f"&asOf={end_ms}"
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            r = await client.get(url, headers=self._auth())
            r.raise_for_status()
            payload = r.json()
        out: list[OHLCVBar] = []
        for b in payload.get("bars", []):
            ts = int(b["timestamp"])
            if ts < start_ms or (end_ms is not None and ts > end_ms):
                continue
            out.append(OHLCVBar(
                ticker=ticker, timestamp=ts, open=float(b["open"]), high=float(b["high"]),
                low=float(b["low"]), close=float(b["close"]), volume=float(b.get("volume") or 0),
            ))
        out.sort(key=lambda x: x.timestamp)
        return out
