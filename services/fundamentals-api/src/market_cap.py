"""Point-in-time market cap = adjusted_close(as_of) × shares_outstanding(as_of) × fx_to_gbp — epic Task 12 (Gap 2).

THE GAP THIS CLOSES (plan Design §8, Gap 2). Until now `market_cap_gbp` was Yahoo's CURRENT
`price.marketCap` scalar, reused at every replay step — a hard look-ahead leak in the Value legs
(`earnings_yield = net_income / market_cap_gbp`, `book_to_market = total_equity / market_cap_gbp`) AND a
*different* price basis than momentum (which differences the as-of adjusted close). The fix computes a
genuinely point-in-time market cap from the SAME adjusted price series momentum reads:

    market_cap_gbp(t, as_of) = adjusted_close(t, as_of)        # bi-temporal daily bar, as-of read (Task 10 keeps it corporate-action-correct)
                             × shares_outstanding(t, as_of)     # dei cover-page PIT fact from the `fundamentals` table (its own knowledge_ts)
                             × fx_to_gbp(currency(t), as_of)     # the platform's single GBP/USD rate (the existing @trader/shared-fx layer)

so Value and Momentum share ONE adjusted-price basis and earnings_yield/book_to_market become
point-in-time. The provider scalar is dropped for covered names (Yahoo stays a live-only fallback in
strategy-engine, never in replay) — see `apply_pit_market_cap` below, which OVERRIDES any provider-supplied
`market_cap_gbp` line item with this computed value (and DROPS it when an input is missing — never a
fabricated 0).

═══ THE IN-CLUSTER READ PATHS (the card asks these be documented + reachable) ═══

* **As-of adjusted close** — `MarketDataReader.adjusted_close_as_of`. Reads market-data-service's
  internal bars endpoint `GET http://market-data-service:3002/internal/api/market-data/bars/{ticker}?interval=daily&range=&asOf=`
  with an internal HS256 JWT (`quant_core.http.internal_jwt.mint_internal_jwt`, the SAME mint
  strategy-engine's `MarketDataClient` uses). The endpoint's bar `close` IS the persisted
  `adjusted_close` (the total-return series momentum differences — CLAUDE.md "persisted `close` =
  provider `adjusted_close`"), so this is literally the same number momentum sees. We take the close of
  the latest bar at/<= as_of. `asOf` is the bars-convention knowledge-time cutoff (camelCase), so the bar
  read is itself point-in-time (a later-revised close is invisible before its knowledge_ts). NOTE:
  market-data-service must allow `fundamentals-api` as an internal caller on that route (a one-line
  allowlist add on the route — done in this task).

* **FX → GBP** — `MarketDataReader.fx_to_gbp`. There is NO historical GBP/USD time series in the platform
  (`@trader/shared-fx` is a single live spot rate); the honest available rate is the platform's published
  one. market-data-service is the single FX writer (`index.ts` `refreshFx`) and publishes GBP-per-1-USD to
  the Redis keys `fx:GBPUSD:lastGood` / `fx:GBPUSD:lastTs` (the consumer contract `RedisGbpUsdProvider`
  reads). We read the SAME keys directly off the shared Redis (the resolver's existing singleton client) —
  no new FX upstream, no key of our own, exactly the platform's consumer-side FX path. GBP is identity
  (rate 1.0); USD multiplies by the rate; an unknown currency / missing rate yields None (the name's market
  cap is then absent — NaN-excluded, never fabricated). A past `as_of` uses this spot rate because it is the
  only rate the platform has — FX is a second-order effect on a *cross-sectional* Value rank (every USD name
  shares the same multiplier, so the rank is invariant to it), and using the live rate is what the existing
  FX layer offers; this is documented as the reuse the card mandates, not a silent approximation.

* **Dividend-yield leg** — `MarketDataReader.dividend_yields_as_of` (wired in the resolver, see
  `apply_dividend_yield`). The platform already computes a point-in-time trailing-12m dividend yield
  (`services/market-data-service/.../dividend-yield.ts`, `GET /internal/api/dividend-yield?tickers=&asOf=`).
  We surface it as the `dividend_yield` line item so Value's THREE legs (div yield, earnings yield,
  book-to-market) share ONE as-of basis. A null yield (no price as-of) is dropped (the factor NaN-excludes);
  a real non-payer's finite 0.0 is kept.

The pure arithmetic (`compute_market_cap_gbp`, `currency_of`) is I/O-free and exhaustively unit-tested; the
`MarketDataReader` is the thin async edge (HTTP + Redis) injected into the resolver, so the computation is
provable in the deps-clean python gate with no live cluster.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from quant_core.fundamentals import MARKET_UK, MARKET_US, market_of

log = logging.getLogger("fundamentals-api.market_cap")

# The canonical line item this module OWNS the computation of (price×shares×fx). The resolver's pivot
# would surface a provider-supplied `market_cap_gbp` fact if one were ever written; this module
# OVERRIDES it (covered names get the computed PIT value, never a provider scalar) — see
# `apply_pit_market_cap`.
MARKET_CAP_KEY = "market_cap_gbp"
SHARES_KEY = "shares_outstanding"
DIVIDEND_YIELD_KEY = "dividend_yield"

# Redis keys market-data-service publishes the GBP-per-1-USD rate under (the single-writer FX contract;
# mirrors packages/shared-fx FX_KEYS so we read EXACTLY what the platform's consumer side reads). No TTL
# on lastGood; lastTs is the unix-ms of the last good write (used for the staleness guard).
FX_LAST_GOOD_KEY = "fx:GBPUSD:lastGood"
FX_LAST_TS_KEY = "fx:GBPUSD:lastTs"

# Sanity bounds on GBP/USD, mirroring FxClient (real GBP/USD spent the last decade in [0.7,0.85]; 2x
# slack). A rate outside this is almost certainly a transposed/garbage value — reject it (→ no market cap
# for USD names this cycle) rather than fabricate a wrong one.
_FX_MIN = 0.5
_FX_MAX = 1.5

# Default staleness ceiling for the published FX rate (ms). market-data-service refreshes hourly; 26h
# matches RedisGbpUsdProvider's default so a rate older than that (the writer stopped) is treated as
# absent rather than perpetually fresh. Overridable for tests.
_FX_MAX_STALE_MS = 26 * 3600_000

# The market-data internal bars range we fetch for an as-of close. 'max' so a deep historical as_of
# (years back, the research/replay regime) still has a bar at/<= as_of; the read-through Redis cache on
# market-data's side keeps repeated reads cheap. Daily interval (the persisted adjusted series).
_BARS_RANGE = "max"
_BARS_INTERVAL = "daily"

# The internal-JWT caller name this service mints as. market-data-service's bars + dividend-yield routes
# must allow this `sub` (a one-line allowlist add on those routes, done in this task) — minting as
# `strategy-engine` would be impersonation; fundamentals-api is its own legitimate internal caller.
CALLER = "fundamentals-api"

DEFAULT_MARKET_DATA_URL = "http://market-data-service:3002"
DEFAULT_HTTP_TIMEOUT_SECONDS = 10.0


def market_data_url() -> str:
    """market-data-service base URL (env, with the in-cluster default — the same default
    strategy-engine's MarketDataClient uses)."""
    return os.getenv("MARKET_DATA_SERVICE_URL", DEFAULT_MARKET_DATA_URL).rstrip("/")


def currency_of(ticker: str) -> Optional[str]:
    """The listing currency a T212 ticker prices in, by suffix — the multiplier's currency for FX→GBP.

    `*_US_EQ` → USD; `*l_EQ` → GBP (LSE prices are pence-killed to GBP at the market-data boundary, so
    the stored close is already GBP — NOT pence). An unroutable suffix → None (no FX basis ⇒ the name's
    market cap is absent, never guessed). Mirrors `quant_core.fundamentals.market_of`'s jurisdiction
    routing, mapped to the price currency."""
    m = market_of(ticker)
    if m == MARKET_US:
        return "USD"
    if m == MARKET_UK:
        return "GBP"
    return None


def compute_market_cap_gbp(
    adjusted_close: Optional[float],
    shares_outstanding: Optional[float],
    fx_to_gbp_rate: Optional[float],
) -> Optional[float]:
    """The PIT market-cap identity, pure: adjusted_close × shares_outstanding × fx_to_gbp_rate (GBP).

    Returns None when ANY input is missing or non-finite or non-positive — a market cap with no honest
    price, no share count, or no FX rate is genuinely unavailable, so the line item is ABSENT (the
    factor NaN-excludes it) rather than a fabricated 0 the optimiser could rank on. `fx_to_gbp_rate` is
    the GBP-per-unit-of-listing-currency multiplier (1.0 for a GBP name; the GBP/USD rate for a USD
    name) — the caller resolves it via `MarketDataReader.fx_to_gbp(currency, …)`.

    No FX/scale fix-up beyond the multiplier: `adjusted_close` is in the listing currency (GBP after the
    pence-kill for LSE, USD for US) and `shares_outstanding` is a pure count, so price×shares is a
    listing-currency market cap and ×rate lands it in GBP."""
    if adjusted_close is None or not _finite_positive(adjusted_close):
        return None
    if shares_outstanding is None or not _finite_positive(shares_outstanding):
        return None
    if fx_to_gbp_rate is None or not _finite_positive(fx_to_gbp_rate):
        return None
    return adjusted_close * shares_outstanding * fx_to_gbp_rate


def _finite_positive(x: float) -> bool:
    """True iff x is a finite, strictly-positive float (a price/shares/rate must be > 0 to be real)."""
    try:
        xf = float(x)
    except (TypeError, ValueError):
        return False
    return xf == xf and xf not in (float("inf"), float("-inf")) and xf > 0.0


def fx_rate_from_redis_values(
    last_good: Optional[str],
    last_ts: Optional[str],
    *,
    now_ms: int,
    max_stale_ms: int = _FX_MAX_STALE_MS,
) -> Optional[float]:
    """Parse + sanity/staleness-gate the GBP-per-1-USD rate from the raw Redis `fx:GBPUSD:{lastGood,lastTs}`
    values, pure. Mirrors RedisGbpUsdProvider: a missing/invalid/out-of-bounds rate → None; a rate older
    than `max_stale_ms` (the writer stopped refreshing) → None (treated as absent, never perpetually
    fresh). Returns the validated rate otherwise. Pulled out as a pure function so the gate proves the
    bounds/staleness logic with no live Redis."""
    if last_good is None:
        return None
    try:
        rate = float(last_good)
    except (TypeError, ValueError):
        return None
    if not (rate == rate and _FX_MIN <= rate <= _FX_MAX):
        return None
    ts = 0
    if last_ts is not None:
        try:
            ts = int(float(last_ts))
        except (TypeError, ValueError):
            ts = 0
    if now_ms - ts > max_stale_ms:
        return None
    return rate


def apply_pit_market_cap(
    line_items: dict[str, float], market_cap_gbp: Optional[float]
) -> dict[str, float]:
    """Override `market_cap_gbp` in a name's line-item dict with the computed PIT value (or DROP it).

    The single mutation point for Gap 2: a covered name's `market_cap_gbp` is ALWAYS the computed
    price×shares×fx value — any provider-supplied scalar that ever landed in `fundamentals` is replaced,
    and a name whose market cap couldn't be computed (missing price/shares/FX) has the key REMOVED so the
    Value legs NaN-exclude it (never a fabricated 0 / never a stale provider scalar in replay). Returns a
    new dict; does not mutate the input."""
    out = dict(line_items)
    if market_cap_gbp is None:
        out.pop(MARKET_CAP_KEY, None)
    else:
        out[MARKET_CAP_KEY] = float(market_cap_gbp)
    return out


def apply_dividend_yield(
    line_items: dict[str, float], dividend_yield: Optional[float]
) -> dict[str, float]:
    """Set/clear the `dividend_yield` line item from the PIT dividend-yield leg.

    A finite yield (incl. a real non-payer's 0.0) is set; a None yield (no price as-of — the leg has no
    honest value) leaves the key ABSENT so the Value factor NaN-excludes it (never a fabricated 0).
    Returns a new dict; does not mutate the input."""
    out = dict(line_items)
    if dividend_yield is None or not (dividend_yield == dividend_yield):  # None or NaN
        out.pop(DIVIDEND_YIELD_KEY, None)
    else:
        out[DIVIDEND_YIELD_KEY] = float(dividend_yield)
    return out


def adjusted_close_at_or_before(bars: list[dict], as_of_ms: Optional[int]) -> Optional[float]:
    """The adjusted close of the latest daily bar at/<= `as_of_ms` (None = latest available), pure.

    `bars` are market-data-service's internal-bars rows ({timestamp, open, high, low, close, volume},
    `close` already the persisted adjusted close). With `as_of_ms`: pick the bar with the greatest
    timestamp not exceeding it (the close momentum would have seen as-of). Without it: the latest bar.
    None when there is no qualifying bar (unseeded ticker / nothing at/<= as_of) → the name's market cap
    is then absent. Defensive against unordered input (sorts by timestamp)."""
    candidates = []
    for b in bars:
        try:
            ts = int(b["timestamp"])
            close = float(b["close"])
        except (KeyError, TypeError, ValueError):
            continue
        if as_of_ms is not None and ts > as_of_ms:
            continue
        candidates.append((ts, close))
    if not candidates:
        return None
    candidates.sort(key=lambda tc: tc[0])
    return candidates[-1][1]


class MarketDataReader:
    """The thin async edge that fetches the two in-cluster inputs PIT market cap needs — the as-of
    adjusted daily close (market-data-service internal bars) and the GBP/USD rate (shared Redis) — plus
    the PIT dividend-yield leg. Injected into the resolver so the arithmetic stays pure/testable.

    `redis` is the resolver's existing singleton client (`src.pool.get_redis`); None disables the FX read
    (USD names then get no market cap — GBP names still do, rate 1.0). All reads degrade to None on any
    failure (a cold market-data-service / Redis blip must never fail a fundamentals read — the name's
    market cap is simply absent that cycle)."""

    def __init__(
        self,
        *,
        redis=None,
        base_url: Optional[str] = None,
        secret: Optional[str] = None,
        timeout: float = DEFAULT_HTTP_TIMEOUT_SECONDS,
        now_ms=None,
    ) -> None:
        self._redis = redis
        self._base_url = (base_url or market_data_url()).rstrip("/")
        # JWT_SECRET is the shared HS256 secret (injected into every service via the trader-secrets
        # envFrom). Falls back to the dev sentinel if unset; market-data's parseInternalHeaders rejects a
        # sentinel-signed token in prod.
        self._secret = secret or os.getenv("JWT_SECRET", "dev-secret-change-me")
        self._timeout = timeout
        self._now_ms = now_ms or (lambda: __import__("time").time() * 1000)

    def _auth_header(self) -> dict:
        from quant_core.http.internal_jwt import mint_internal_jwt

        return {"Authorization": f"Bearer {mint_internal_jwt(CALLER, self._secret)}"}

    async def fx_to_gbp(self, currency: Optional[str]) -> Optional[float]:
        """GBP-per-unit multiplier for `currency`: 1.0 for GBP (identity), the published GBP/USD rate for
        USD, None otherwise (unknown currency / no rate / stale rate). Reads the SAME Redis keys
        market-data-service publishes (the consumer-side FX path); a Redis failure degrades to None."""
        if currency == "GBP":
            return 1.0
        if currency != "USD":
            return None  # unroutable currency — no FX basis (the name's market cap is then absent)
        if self._redis is None:
            return None
        try:
            last_good = await self._redis.get(FX_LAST_GOOD_KEY)
            last_ts = await self._redis.get(FX_LAST_TS_KEY)
        except Exception as exc:  # noqa: BLE001 — an FX read failure degrades to None, never fails the request
            log.warning("[market_cap] FX read failed: %s", exc)
            return None
        return fx_rate_from_redis_values(last_good, last_ts, now_ms=int(self._now_ms()))

    async def adjusted_close_as_of(self, ticker: str, as_of_ms: Optional[int]) -> Optional[float]:
        """The as-of adjusted daily close for `ticker` (the SAME series momentum uses), or None.

        Reads market-data-service's internal bars endpoint with the internal JWT, passing `asOf` so the
        bar read is itself point-in-time. Returns the close of the latest bar at/<= as_of. Any failure
        (HTTP error, no bars, market-data down) degrades to None — the name's market cap is then absent
        that cycle, never fabricated."""
        import httpx

        url = (
            f"{self._base_url}/internal/api/market-data/bars/{ticker}"
            f"?interval={_BARS_INTERVAL}&range={_BARS_RANGE}"
        )
        if as_of_ms is not None:
            url += f"&asOf={as_of_ms}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.get(url, headers=self._auth_header())
                r.raise_for_status()
                payload = r.json()
        except Exception as exc:  # noqa: BLE001 — a bars read failure degrades to None
            log.warning("[market_cap] adjusted-close read failed for %s: %s", ticker, exc)
            return None
        return adjusted_close_at_or_before(payload.get("bars") or [], as_of_ms)

    async def dividend_yields_as_of(
        self, tickers: list[str], as_of_ms: Optional[int]
    ) -> dict[str, float]:
        """Point-in-time trailing-12m dividend yield per ticker from market-data-service's
        `/internal/api/dividend-yield?tickers=&asOf=` (the Value div-yield leg). Returns only names with a
        FINITE yield (a null yield — no price as-of — is dropped, so the host never injects a fabricated
        0; a real non-payer's 0.0 is kept). Any failure degrades to {} (the leg is simply absent that
        cycle). Empty on no tickers."""
        if not tickers:
            return {}
        import httpx

        url = f"{self._base_url}/internal/api/dividend-yield?tickers={','.join(tickers)}"
        if as_of_ms is not None:
            url += f"&asOf={as_of_ms}"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.get(url, headers=self._auth_header())
                r.raise_for_status()
                payload = r.json()
        except Exception as exc:  # noqa: BLE001 — a dividend-yield read failure degrades to {}
            log.warning("[market_cap] dividend-yield read failed: %s", exc)
            return {}
        out: dict[str, float] = {}
        for t, d in (payload.get("dividendYields") or {}).items():
            dy = (d or {}).get("dividendYield")
            if dy is not None:
                try:
                    out[t] = float(dy)
                except (TypeError, ValueError):
                    continue
        return out
