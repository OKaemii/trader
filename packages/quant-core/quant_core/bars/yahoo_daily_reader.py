"""YahooDailyBarsReader — multi-year *adjusted* daily history for the offline backtest.

This is the **research** data path, deliberately separate from the live path
(TwelveData/market-data-service, 5m, metered). Rationale (Phase 4 decision):

  - The backtest is offline research run iteratively; routing multi-year daily through
    market-data-service would make MDS fetch+cache years of daily per ticker (scope creep)
    and couple backtest availability to MDS uptime.
  - The live TwelveData budget is 800 credits/day *per account* with an in-process limiter
    that a separate backtest pod cannot see — a research binge would silently starve live
    signal generation. Yahoo daily is free, unmetered, ~20y deep, and already the platform's
    source for FX + sector data, so research can never starve live.
  - Yahoo's `/v8/finance/chart` returns `adjclose` (dividend+split adjusted) for free — the
    standard total-return series for a factor backtest. TwelveData's free tier does not.

Implements the same `BarsReader` Protocol as `LiveBarsReader`, so `Replay`/`build_replay`
are agnostic to which path backs them — the only difference is `make_bars_reader('yahoo_daily')`.

Performance contract: a replay calls `history_as_of` once per rebalance instant (hundreds of
times). Each ticker is fetched from Yahoo **exactly once** and cached in memory; the
orchestrator calls `prefetch(...)` up front so the replay itself touches no network. The
parse step (`parse_chart`) is a pure function so it is unit-testable without httpx/network.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

from ..strategy.contract import HistoryView
from ..types import OHLCVBar

_YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

# Legacy-rename + share-class map so the curated universe resolves on Yahoo. T212/values.yaml
# keep pre-rebrand symbols (FB) and dotless share classes (BRKB); Yahoo wants META and BRK-B.
_SYMBOL_RENAMES = {"FB": "META", "BRKB": "BRK-B"}


def to_yahoo_symbol(ticker: str) -> str:
    """Resolve a research ticker to a Yahoo symbol.

    The Phase-4 universe is curated bare symbols (S&P 100, e.g. ``AAPL``) and Yahoo-native
    index symbols (``^GSPC``), which pass through unchanged. T212-shaped tickers are also
    accepted defensively: ``AAPL_US_EQ`` → ``AAPL``; ``VODl_EQ`` → ``VOD.L``.
    """
    if ticker.startswith("^") or "." in ticker:
        return ticker  # already a Yahoo index / suffixed symbol
    parts = ticker.split("_")
    raw = parts[0]
    # LSE T212 shape: SYMBOLl_EQ → the trailing 'l' is the T212 LSE marker.
    if len(parts) == 2 and parts[1] == "EQ" and raw.endswith("l"):
        base = raw[:-1]
        return f"{_SYMBOL_RENAMES.get(base, base)}.L"
    base = raw
    if len(parts) >= 3 and parts[1] == "US":
        base = raw  # US listing: bare symbol, no suffix
    return _SYMBOL_RENAMES.get(base, base)


def _price_scale(currency: Optional[str]) -> tuple[Optional[str], float]:
    """Pence kill-switch, identical policy to the live yahoo-client: 'GBp'/'GBX' → ÷100, GBP."""
    if not currency:
        return None, 1.0
    if currency == "GBp" or currency.upper() == "GBX":
        return "GBP", 0.01
    c = currency.upper()
    if c == "GBP":
        return "GBP", 1.0
    if c == "USD":
        return "USD", 1.0
    return None, 1.0


def parse_chart(payload: dict, ticker: str) -> list[OHLCVBar]:
    """Pure parse of a Yahoo `/v8/finance/chart` response into oldest-first OHLCVBars.

    `close` is the **adjusted** (total-return) close so log-returns are dividend-clean;
    `raw_close` keeps the unadjusted close and `adjustment_factor = adjclose/close_raw`.
    O/H/L are scaled by the same per-bar factor so the bar stays internally consistent on
    the adjusted scale. Indices (no `adjclose` block) fall back to the raw close. Rows with a
    null/non-positive close are skipped exactly as the live extractor does.
    """
    chart = payload.get("chart") or {}
    results = chart.get("result") or []
    if not results:
        return []
    result = results[0] or {}
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    quote = (indicators.get("quote") or [{}])[0] or {}
    adj_block = (indicators.get("adjclose") or [{}])
    adjclose = (adj_block[0] or {}).get("adjclose") if adj_block else None

    currency = (result.get("meta") or {}).get("currency")
    _, scale = _price_scale(currency)

    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []

    bars: list[OHLCVBar] = []
    for i, ts_s in enumerate(timestamps):
        if ts_s is None:
            continue
        raw_c = closes[i] if i < len(closes) else None
        if raw_c is None or raw_c <= 0:
            continue
        raw_close = float(raw_c) * scale
        adj_c = None
        if adjclose is not None and i < len(adjclose) and adjclose[i] is not None and adjclose[i] > 0:
            adj_c = float(adjclose[i]) * scale
        close = adj_c if adj_c is not None else raw_close
        factor = (close / raw_close) if raw_close > 0 else 1.0

        def _adj(arr, fallback_raw):
            v = arr[i] if i < len(arr) and arr[i] is not None else None
            base = (float(v) * scale) if v is not None else fallback_raw
            return base * factor

        bars.append(
            OHLCVBar(
                ticker=ticker,
                timestamp=int(ts_s) * 1000,  # epoch seconds → ms
                open=_adj(opens, raw_close),
                high=_adj(highs, raw_close),
                low=_adj(lows, raw_close),
                close=close,
                volume=float(volumes[i]) if i < len(volumes) and volumes[i] is not None else 0.0,
                raw_close=raw_close,
                adjusted_close=close,
                adjustment_factor=factor,
            )
        )
    bars.sort(key=lambda b: b.timestamp)
    return bars


class YahooDailyBarsReader:
    """In-memory-cached daily reader. One Yahoo fetch per ticker; all reads slice the cache."""

    def __init__(
        self,
        *,
        timeout: float = 30.0,
        max_concurrency: int = 8,
        max_retries: int = 3,
        base_url: Optional[str] = None,
    ) -> None:
        self._timeout = timeout
        self._sema = asyncio.Semaphore(max_concurrency)
        self._max_retries = max_retries
        self._base_url = (base_url or os.getenv("YAHOO_CHART_BASE") or _YAHOO_CHART_BASE).rstrip("/")
        # ticker → full fetched series (oldest-first); and the [lo,hi] ms window it covers.
        self._cache: dict[str, list[OHLCVBar]] = {}
        self._range: dict[str, tuple[int, int]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # ── network (lazy httpx; the [http] extra) ────────────────────────────────────
    async def _fetch(self, symbol: str, start_ms: int, end_ms: int) -> dict:
        import httpx

        # Yahoo wants epoch *seconds*; pad a day each side so boundary bars are included.
        p1 = max(0, start_ms // 1000 - 86_400)
        p2 = end_ms // 1000 + 86_400
        url = f"{self._base_url}/{symbol}"
        params = {"period1": str(p1), "period2": str(p2), "interval": "1d", "events": "div,splits"}
        headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
        last_exc: Optional[Exception] = None
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for attempt in range(self._max_retries):
                try:
                    r = await client.get(url, params=params, headers=headers)
                    if r.status_code == 429 or r.status_code >= 500:
                        await asyncio.sleep(0.5 * (2 ** attempt))
                        continue
                    r.raise_for_status()
                    return r.json()
                except Exception as exc:  # noqa: BLE001 — degrade to empty, never crash the backtest
                    last_exc = exc
                    await asyncio.sleep(0.5 * (2 ** attempt))
        if last_exc is not None:
            # One ticker failing must not abort the whole run; the caller treats empty as
            # "no data for this ticker" (it drops out of the universe for that period).
            import logging

            logging.getLogger(__name__).warning("yahoo daily fetch failed for %s: %s", symbol, last_exc)
        return {}

    async def _ensure(self, ticker: str, start_ms: int, end_ms: int) -> list[OHLCVBar]:
        covered = self._range.get(ticker)
        if covered is not None and covered[0] <= start_ms and covered[1] >= end_ms:
            return self._cache[ticker]
        lock = self._locks.setdefault(ticker, asyncio.Lock())
        async with lock:
            covered = self._range.get(ticker)
            if covered is not None and covered[0] <= start_ms and covered[1] >= end_ms:
                return self._cache[ticker]
            lo = min(start_ms, covered[0]) if covered else start_ms
            hi = max(end_ms, covered[1]) if covered else end_ms
            async with self._sema:
                payload = await self._fetch(to_yahoo_symbol(ticker), lo, hi)
            bars = parse_chart(payload, ticker)
            self._cache[ticker] = bars
            self._range[ticker] = (lo, hi)
            return bars

    # ── public API: prefetch + BarsReader Protocol ────────────────────────────────
    async def prefetch(self, tickers: list[str], start_ms: int, end_ms: int) -> None:
        """Batch-warm the cache so the subsequent replay touches no network."""
        await asyncio.gather(*(self._ensure(t, start_ms, end_ms) for t in dict.fromkeys(tickers)))

    async def history_as_of(
        self, tickers: list[str], as_of_ms: int, lookback_bars: int
    ) -> HistoryView:
        closes: dict[str, list[float]] = {}
        volumes: dict[str, list[float]] = {}
        timestamps: dict[str, list[int]] = {}
        for t in tickers:
            series = self._cache.get(t)
            if series is None:
                # Safety net for the un-prefetched path (tests / ad-hoc): fetch a wide window.
                series = await self._ensure(t, as_of_ms - 5 * 365 * 86_400_000, as_of_ms)
            window = [b for b in series if b.timestamp <= as_of_ms][-lookback_bars:]
            if not window:
                continue
            closes[t] = [b.close for b in window]
            volumes[t] = [b.volume for b in window]
            timestamps[t] = [b.timestamp for b in window]
        return HistoryView(closes=closes, volumes=volumes, timestamps=timestamps)

    async def daily_bars(
        self, ticker: str, start_ms: int, end_ms: Optional[int] = None
    ) -> list[OHLCVBar]:
        hi = end_ms if end_ms is not None else (self._range.get(ticker, (start_ms, start_ms))[1])
        series = await self._ensure(ticker, start_ms, hi)
        return [b for b in series if b.timestamp >= start_ms and (end_ms is None or b.timestamp <= end_ms)]
