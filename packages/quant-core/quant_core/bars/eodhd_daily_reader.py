"""EodhdDailyBarsReader — multi-year *adjusted* daily history for the offline backtest, EODHD-sourced.

This is the **research** data path, deliberately separate from the live 5m path
(TwelveData/market-data-service, metered). It replaces ``YahooDailyBarsReader`` as the validator's
daily price panel so the platform depends only on its own feeds (EODHD) and never on Yahoo
(Thread C — kill all Yahoo dependency). Rationale:

  - EODHD ``/eod`` is already the platform's persisted-daily-series upstream (the ``eodhd_scan``
    live path backfills the ``interval:'daily'`` series from it), so the research panel and the
    live daily series read the SAME provider — no second pricing source to reconcile.
  - EODHD ``/eod`` returns ``adjusted_close`` (split + dividend adjusted, total-return) for free,
    so log-returns are dividend-clean — the standard total-return series a factor backtest needs.
  - The live OHLCV budget is the in-process TwelveData/EODHD limiter that a separate backtest pod
    cannot see; routing multi-year daily through market-data-service would couple backtest
    availability to MDS uptime and let a research binge starve live signal generation. A dedicated
    reader against EODHD ``/eod`` keeps research isolated from the live cycle.

Implements the same ``BarsReader`` Protocol as ``LiveBarsReader``/``YahooDailyBarsReader``, so
``Replay``/``build_replay`` are agnostic to which path backs them — the only difference is
``make_bars_reader('eodhd_daily')``. The symbol mapping mirrors the live TS ``toEodhdSymbol``
(``services/market-data-service/.../eodhd-client.ts``): US → ``SYMBOL.US``, LSE → ``SYMBOL.LSE``,
S&P 500 index ``^GSPC`` → ``GSPC.INDX``. T212-shaped tickers route through the canonical
``quant_core.ticker_identity`` adapter (the one suffix parser) so the reader never re-derives the
``_US_EQ`` / ``l_EQ`` rules.

Performance contract: a replay calls ``history_as_of`` once per rebalance instant (hundreds of
times). Each ticker is fetched from EODHD **exactly once** and cached in memory; the orchestrator
calls ``prefetch(...)`` up front so the replay itself touches no network. The parse step
(``parse_eod``) is a pure function so it is unit-testable without httpx/network.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

from ..strategy.contract import HistoryView
from ..ticker_identity import Trading212TickerAdapter
from ..types import OHLCVBar

_EODHD_BASE = "https://eodhd.com/api"

_ADAPTER = Trading212TickerAdapter()

# Legacy-rename + share-class map so the curated universe resolves on EODHD. Mirrors the live
# TS client's SYMBOL_RENAMES (FB→META) plus the dotless-share-class convention (EODHD US spells a
# share class with a dash: BRKB → BRK-B, matching the Yahoo reader's BRKB → BRK-B). The bare
# DEFAULT_SP100 carries both forms, so both must resolve.
_SYMBOL_RENAMES = {"FB": "META", "BRKB": "BRK-B"}

# Index symbols the validator passes as benchmarks (Yahoo-native carets) → the EODHD INDX form.
# The walk-forward path benchmarks against ^GSPC (the S&P 500 index); EODHD lists it as GSPC.INDX.
# The MCPT benchmark suite (SPY + 11 sector SPDRs) are bare US ETF symbols → handled as US below.
_INDEX_MAP = {"^GSPC": "GSPC.INDX", "^DJI": "DJI.INDX", "^IXIC": "IXIC.INDX"}


def to_eodhd_symbol(ticker: str) -> str:
    """Resolve a research ticker to an EODHD ``SYMBOL.EXCHANGE``.

    The Phase-4 universe is curated bare symbols (S&P 100, e.g. ``AAPL`` → ``AAPL.US``) and
    benchmark symbols (``SPY`` → ``SPY.US``; the ``^GSPC`` index → ``GSPC.INDX``). T212-shaped
    tickers are accepted defensively via the canonical adapter: ``AAPL_US_EQ`` → ``AAPL.US``;
    ``VODl_EQ`` → ``VOD.LSE``. A Yahoo-style ``BP.L`` is normalised to ``BP.LSE`` so a mixed-source
    universe still resolves.
    """
    t = ticker.strip()
    # Index symbols (Yahoo carets) map to the EODHD INDX exchange.
    if t in _INDEX_MAP:
        return _INDEX_MAP[t]
    # Yahoo LSE suffix `.L` → EODHD `.LSE` (e.g. BP.L → BP.LSE). Other dotted symbols (already an
    # EODHD SYMBOL.EXCHANGE) pass through unchanged.
    if "." in t:
        base, _, suffix = t.partition(".")
        if suffix.upper() == "L":
            return f"{_SYMBOL_RENAMES.get(base, base)}.LSE"
        return t
    # T212-shaped forms (`_US_EQ` / `l_EQ`) route through the one suffix parser. A bare symbol that
    # is not a T212 ticker raises there — caught below and treated as a bare US listing.
    try:
        ident = _ADAPTER.from_t212(t)
    except ValueError:
        base = _SYMBOL_RENAMES.get(t, t)
        return f"{base}.US"  # bare symbol ⇒ US listing (the curated default; LSE comes via l_EQ)
    base = _SYMBOL_RENAMES.get(ident.symbol, ident.symbol)
    return f"{base}.LSE" if ident.market == "LSE" else f"{base}.US"


def _price_scale(eodhd_symbol: str) -> float:
    """Pence kill-switch, identical policy to the live eodhd-client's eodhdCurrencyForExchange:
    an LSE listing quotes common stock in pence (GBX) → ÷100 to GBP; US (and indices) → ×1.

    EODHD ``/eod`` carries no per-bar currency, so the scale is inferred from the exchange suffix
    exactly as the live path does. The >=£5B common-stock universe quotes in pence; a GBP/USD-
    denominated LSE ETF would be mis-scaled — acceptable + matches the live boundary policy.
    """
    return 0.01 if eodhd_symbol.endswith(".LSE") else 1.0


def parse_eod(rows: list[dict], ticker: str, price_scale: float = 1.0) -> list[OHLCVBar]:
    """Pure parse of an EODHD ``/eod`` response (list of daily rows) into oldest-first OHLCVBars.

    ``close`` is the **adjusted** (total-return) close so log-returns are dividend-clean;
    ``raw_close`` keeps the unadjusted close and ``adjustment_factor = adjusted_close/close``.
    O/H/L are scaled by the same per-bar factor so the bar stays internally consistent on the
    adjusted scale, then by ``price_scale`` (pence kill). Rows with a null/non-positive close are
    skipped exactly as the live ``eodRowToDailyBar`` does. Mirrors the live bar construction
    (``services/market-data-service/.../eodhd-client.ts`` ``eodRowToDailyBar``).
    """
    bars: list[OHLCVBar] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        date = r.get("date")
        if not date:
            continue
        obs_ms = _date_to_ms(str(date))
        if obs_ms is None:
            continue
        raw_c = _num(r.get("close"))
        if raw_c is None or raw_c <= 0:
            continue
        raw_close = raw_c * price_scale
        adj_raw = _num(r.get("adjusted_close"))
        # Fall back to the raw close when adjusted_close is absent/non-positive (e.g. an index).
        adj_c = adj_raw if (adj_raw is not None and adj_raw > 0) else raw_c
        adjusted_close = adj_c * price_scale
        factor = (adj_c / raw_c) if raw_c > 0 else 1.0

        def _adj(key: str) -> float:
            v = _num(r.get(key))
            base = (v * price_scale) if v is not None else raw_close
            return base * factor

        bars.append(
            OHLCVBar(
                ticker=ticker,
                timestamp=obs_ms,
                open=_adj("open"),
                high=_adj("high"),
                low=_adj("low"),
                close=adjusted_close,
                volume=(_num(r.get("volume")) or 0.0),
                raw_close=raw_close,
                adjusted_close=adjusted_close,
                adjustment_factor=factor,
            )
        )
    bars.sort(key=lambda b: b.timestamp)
    return bars


def _num(v: object) -> Optional[float]:
    """Finite-float coercion; None on a missing/NaN/inf/non-numeric value (mirrors the TS numOr
    finite guard so a malformed EODHD cell is dropped, never injected as NaN)."""
    if v is None:
        return None
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / ±inf
        return None
    return f


def _date_to_ms(date: str) -> Optional[int]:
    """EODHD 'YYYY-MM-DD' → the UTC-midnight observation instant in ms. None on a malformed date.
    Matches the live ``Date.parse(`${date}T00:00:00Z`)`` (the daily observation_ts convention)."""
    from datetime import datetime, timezone

    try:
        d = datetime.strptime(date[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None
    return int(d.timestamp() * 1000)


class EodhdDailyBarsReader:
    """In-memory-cached daily reader. One EODHD fetch per ticker; all reads slice the cache."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        max_concurrency: int = 8,
        max_retries: int = 3,
        base_url: Optional[str] = None,
    ) -> None:
        self._api_key = api_key if api_key is not None else os.getenv("EODHD_API_KEY", "")
        self._timeout = timeout
        self._sema = asyncio.Semaphore(max_concurrency)
        self._max_retries = max_retries
        self._base_url = (base_url or os.getenv("EODHD_BASE_URL") or _EODHD_BASE).rstrip("/")
        # ticker → full fetched series (oldest-first); and the [lo,hi] ms window it covers.
        self._cache: dict[str, list[OHLCVBar]] = {}
        self._range: dict[str, tuple[int, int]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # ── network (lazy httpx; the [http] extra) ────────────────────────────────────
    async def _fetch(self, eodhd_symbol: str, start_ms: int, end_ms: int) -> list[dict]:
        import httpx

        # EODHD `/eod` takes ISO 'YYYY-MM-DD' bounds (inclusive); pad a day each side so boundary
        # bars are included. period=d daily, order=a oldest-first.
        from datetime import datetime, timezone

        from_iso = datetime.fromtimestamp(max(0, start_ms) / 1000 - 86_400, tz=timezone.utc).strftime("%Y-%m-%d")
        to_iso = datetime.fromtimestamp(end_ms / 1000 + 86_400, tz=timezone.utc).strftime("%Y-%m-%d")
        url = f"{self._base_url}/eod/{eodhd_symbol}"
        params = {
            "from": from_iso, "to": to_iso, "period": "d", "order": "a",
            "api_token": self._api_key, "fmt": "json",
        }
        last_exc: Optional[Exception] = None
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            for attempt in range(self._max_retries):
                try:
                    r = await client.get(url, params=params)
                    if r.status_code == 429 or r.status_code >= 500:
                        await asyncio.sleep(0.5 * (2 ** attempt))
                        continue
                    r.raise_for_status()
                    payload = r.json()
                    return payload if isinstance(payload, list) else []
                except Exception as exc:  # noqa: BLE001 — degrade to empty, never crash the backtest
                    last_exc = exc
                    await asyncio.sleep(0.5 * (2 ** attempt))
        if last_exc is not None:
            # One ticker failing must not abort the whole run; the caller treats empty as "no data
            # for this ticker" (it drops out of the universe for that period).
            import logging

            logging.getLogger(__name__).warning("eodhd daily fetch failed for %s: %s", eodhd_symbol, last_exc)
        return []

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
            eodhd_symbol = to_eodhd_symbol(ticker)
            async with self._sema:
                rows = await self._fetch(eodhd_symbol, lo, hi)
            bars = parse_eod(rows, ticker, _price_scale(eodhd_symbol))
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
