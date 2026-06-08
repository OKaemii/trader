"""FundamentalsAsOf — the point-in-time (PIT) fundamentals seam (strategy-engine side).

This is the socket the research-factor layer reads through. The host fills
`HistoryView.fundamentals[ticker]` from a `FundamentalsAsOf` provider, so the factor code
(`quant_core.strategy.factors` QualityFactor / ValueFactor) never learns whether the numbers
came from today's forward-only Yahoo snapshot or a point-in-time warehouse — it just consumes a
snake_case line-item dict.

CONTRACT MOVED TO quant-core. The canonical pieces every side agrees on — the snake_case
`LINE_ITEMS` key set, the `FundamentalsAsOf` Protocol, the `SOURCE_*` stamps, and the `MARKET_*` /
`market_of()` router — now live in `quant_core.fundamentals.contract` (read by both live and replay,
and produced by the fundamentals-ingestion write-path; one source of truth so the writer and the
readers cannot drift). They are RE-EXPORTED from this module unchanged, so every existing import
path (`from src.infrastructure.fundamentals_as_of import FundamentalsAsOf, market_of, SOURCE_*,
MARKET_*`) keeps working. Only `YahooFundamentalsAsOf` stays here, because it depends on this
service's `MarketDataClient`.

WHY a seam (and only a Yahoo seam here today):
EODHD Fundamentals is not entitled, so there is no deep historical fundamentals source in THIS
service. The honest consequence is that Quality and the earnings/book leg of Value are
**forward-only**: they can be computed for ≈`now` (the live snapshot) but NOT reconstructed for a
past knowledge-time without look-ahead. Rather than fabricate a historical proxy (which would leak
future information into a backtest), a past `as_of_ms` resolves to an EMPTY dict, and the factors
then degrade to None for that name in that cycle. That is the whole point: never a look-ahead proxy.
The PIT warehouse (the wider epic, served by `fundamentals-api`) is what answers a past `as_of_ms`
honestly via the relocated Protocol; this module's Yahoo impl remains the live fallback.

Return shape — the snake_case line items the factors read off `HistoryView.fundamentals[t]`
(keys drawn from `quant_core.fundamentals.LINE_ITEMS`; QualityFactor: net_income, total_equity,
gross_profit, total_revenue, total_debt, earnings_stability; ValueFactor: dividend_yield,
net_income, total_equity, market_cap_gbp). A field the upstream snapshot doesn't carry is simply
absent (the factor z-scores over the names that have it; a missing component is NaN-excluded, never
a false 0). An empty dict means "no fundamentals for this name/as-of" — the forward-only signal.
"""

from __future__ import annotations

import os
import time

import httpx

# Single source of truth for internal-JWT minting (mirrors shared-auth/internal-jwt.ts) — the PIT
# seam authenticates to fundamentals-api as `strategy-engine`, the same caller the bars/fundamentals
# in-cluster routes already authorize.
from quant_core.http.internal_jwt import mint_internal_jwt

# Re-export the canonical contract from quant-core so existing imports of these names from this
# module keep resolving (back-compat). The single source of truth is quant_core.fundamentals.
from quant_core.fundamentals import (  # noqa: F401  (re-exported for back-compat)
    LINE_ITEMS,
    MARKET_OTHER,
    MARKET_UK,
    MARKET_US,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    SOURCE_YAHOO_SNAPSHOT,
    FundamentalsAsOf,
    market_of,
)

from .market_data_client import MarketDataClient

# How close to `now` an `as_of_ms` must be for the forward-only Yahoo snapshot to answer it.
# A live cycle's as_of is ≈now (sub-second to a few minutes old); a backfill replays dates days
# to years in the past. One trading day of slack comfortably admits the former while rejecting
# the latter — the snapshot describes the present, so a past as_of has no honest answer. This is
# Yahoo-snapshot-specific (the forward-only gate), so it stays here, not in the shared contract.
FORWARD_ONLY_TOLERANCE_MS = 24 * 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


class YahooFundamentalsAsOf:
    """Forward-only `FundamentalsAsOf` backed by the live Yahoo snapshot.

    The current `company_fundamentals` snapshot (Yahoo `quoteSummary`, monthly TTL) describes
    fundamentals as they stand *today* — there is no as-of dimension. So this impl is honest
    about its one capability and its one limit:
      - an `as_of_ms` within `FORWARD_ONLY_TOLERANCE_MS` of `now` → the live snapshot's line
        items (the factors compute Quality/Value for the current cycle);
      - any older `as_of_ms` → `{}`  (no look-ahead proxy; historical Quality/Value stay None).

    It reuses `MarketDataClient.fetch_fundamentals` (the existing internal Yahoo path) rather
    than re-implementing the call, then remaps to the full field set the factors read.
    """

    def __init__(self, client: MarketDataClient, *, tolerance_ms: int = FORWARD_ONLY_TOLERANCE_MS) -> None:
        self._client = client
        self._tolerance_ms = tolerance_ms

    def _is_now(self, as_of_ms: int) -> bool:
        """True when `as_of_ms` is close enough to the present for the snapshot to answer it.
        A future as_of (clock skew) is also ≈now; only a PAST as_of beyond the tolerance is
        the forward-only refusal."""
        return (_now_ms() - as_of_ms) <= self._tolerance_ms

    def source_for(self, ticker: str) -> str:
        # market_of() routes the PIT source; for the snapshot the source is always Yahoo.
        return SOURCE_YAHOO_SNAPSHOT

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Batch form — the host fills the whole universe in one round-trip per cycle. A past
        `as_of_ms` returns `{}` for ALL names (forward-only); ≈now returns each name's snapshot
        line items. Names with no upstream fundamentals are simply absent from the map."""
        if not tickers or not self._is_now(as_of_ms):
            return {}
        raw = await self._client.fetch_fundamentals(tickers)
        return {t: _to_factor_line_items(d) for t, d in raw.items()}

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name PIT lookup. Forward-only: a past `as_of_ms` returns `{}`."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


def _to_factor_line_items(snapshot: dict[str, float]) -> dict[str, float]:
    """Project a `MarketDataClient.fetch_fundamentals` row onto the snake_case keys the
    Quality/Value factors read off `HistoryView.fundamentals[t]` (a subset of `LINE_ITEMS`).

    `fetch_fundamentals` already returns snake_case (market_cap_gbp, net_income, total_equity,
    total_debt, …). We pass those through and carry the value-only fields (gross_profit,
    total_revenue, earnings_stability, dividend_yield) when the snapshot supplies them. A field
    the snapshot lacks is OMITTED — the factor NaN-excludes a missing component rather than
    reading a fabricated 0 (the existing fetch_fundamentals defaults absent numerics to 0.0,
    which is fine for the QMJ balance-sheet items it was written for but would be a false signal
    for a margin/stability/yield leg, so those are only emitted when actually present)."""
    out: dict[str, float] = {}
    # Balance-sheet / income items QualityFactor + ValueFactor's earnings/book legs read.
    for key in ("market_cap_gbp", "net_income", "total_equity", "total_debt",
                "gross_profit", "total_revenue"):
        if key in snapshot:
            out[key] = float(snapshot[key])
    # Optional legs — only when the snapshot actually carries them (else NaN-excluded, not 0).
    for key in ("earnings_stability", "dividend_yield"):
        val = snapshot.get(key)
        if val is not None:
            out[key] = float(val)
    return out


# fundamentals-api in-cluster base URL (the read-side of the PIT warehouse). Port 8011, the seam
# hot path /internal/api/fundamentals-pit (camelCase asOf — the bars/pg-bar-reader convention; the
# headline /pit admin route uses as_of). Overridable for tests / non-default deploys.
_DEFAULT_FUNDAMENTALS_API_URL = "http://fundamentals-api:8011"
_PIT_CALLER = "strategy-engine"
_PIT_TIMEOUT_SECONDS = 10.0


class PitFundamentalsAsOf:
    """Point-in-time `FundamentalsAsOf` backed by the PIT fundamentals warehouse (fundamentals-api).

    This is the honest historical source the seam docstring reserves: unlike the forward-only Yahoo
    snapshot, it answers ANY past `as_of_ms` by reading the bi-temporal `fundamentals` table through
    fundamentals-api's `/internal/api/fundamentals-pit?tickers=&asOf=` (the no-look-ahead guard lives
    in that service's SQL — `knowledge_ts <= asOf`). It returns the snake_case `LINE_ITEMS` dict the
    Quality/Value factors read off `HistoryView.fundamentals[t]`, with `market_cap_gbp` already the
    Gap-2 computed price×shares×fx value for covered names and the PIT `dividend_yield` leg merged in.

    LIVE SAFETY — the single most important property: this NEVER throws into the cycle. fundamentals-api
    being down, slow, 503 (cold warehouse), or returning malformed JSON all degrade to `{}` (logged
    once), so `RoutingFundamentalsAsOf` can fall back to Yahoo. The strategy's signal-emission path must
    not depend on a research-fundamentals service being reachable.

    SOURCE STAMP — `source_for(ticker)` routes by `market_of()`: `pit-edgar` for `*_US_EQ`,
    `pit-companies-house` for `*l_EQ`. The stamp flows into `factor_scores` so the re-backfill knows
    which previously-`None` historical rows it may upgrade in place.

    AUTH — mints an internal JWT as `strategy-engine` (same caller, same `JWT_SECRET`, same
    `mint_internal_jwt` as `MarketDataClient`) and sends it as `Authorization: Bearer …`. The route is
    in-cluster; sending the token matches the platform convention and is forward-compatible if the
    service adds caller verification.
    """

    def __init__(
        self,
        base_url: str | None = None,
        secret: str | None = None,
        *,
        timeout: float = _PIT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = (
            base_url or os.getenv("FUNDAMENTALS_API_URL") or _DEFAULT_FUNDAMENTALS_API_URL
        ).rstrip("/")
        # Same shared HS256 secret as the Node services' mintInternalJwt (JWT_SECRET in trader-secrets).
        self._secret = secret or os.getenv("JWT_SECRET", "dev-secret-change-me")
        self._timeout = timeout
        self._warned = False  # one-shot degrade log (don't spam the cycle on a persistent outage)

    def _auth_header(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {mint_internal_jwt(_PIT_CALLER, self._secret)}"}

    def source_for(self, ticker: str) -> str:
        """The per-jurisdiction PIT source stamp persisted alongside each factor this provider feeds:
        `pit-edgar` for US, `pit-companies-house` for UK (routed by the T212 suffix). A non-US/UK name
        is never routed here by `RoutingFundamentalsAsOf`, but we still answer the contract honestly
        (UK is the only non-US route, so anything else falls back to the EDGAR stamp as a sensible
        default that this provider would never actually be asked for)."""
        return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Batch PIT lookup — one round-trip for the whole (US/UK) slice the router hands us. Returns
        each name's line-item dict as known at `as_of_ms`; names the warehouse has no fact for ≤ asOf
        are ABSENT from the map (so the router falls back to Yahoo for them in live). Any transport /
        warehouse / parse failure returns `{}` (logged once) — never raised into the cycle."""
        if not tickers:
            return {}
        url = (
            f"{self._base_url}/internal/api/fundamentals-pit"
            f"?tickers={','.join(tickers)}&asOf={int(as_of_ms)}"
        )
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.get(url, headers=self._auth_header())
                r.raise_for_status()
                payload = r.json()
        except Exception as exc:  # noqa: BLE001 — the live cycle must never break on a PIT outage
            if not self._warned:
                print(
                    f"[strategy-engine:pit-fundamentals] read failed (degrading to Yahoo fallback): {exc!r}",
                    flush=True,
                )
                self._warned = True
            return {}
        out: dict[str, dict[str, float]] = {}
        for ticker, tf in (payload.get("fundamentals") or {}).items():
            line_items = _pit_line_items(tf)
            if line_items:  # an empty line-item dict = "no PIT fact for this name" → let it fall back
                out[ticker] = line_items
        return out

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name PIT lookup over `fetch_many`. `{}` when the warehouse has no fact ≤ asOf."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


def _pit_line_items(payload: dict) -> dict[str, float]:
    """Project one ticker's fundamentals-api payload onto the snake_case `LINE_ITEMS` the factors read.

    The seam payload per name is `{ <line items>, source, observation_ts, knowledge_ts }` (the resolver
    already emits the canonical snake_case keys via the shared contract — see fundamentals-api
    `resolver.py`). We keep only the `LINE_ITEMS` keys with a FINITE numeric value: the provenance keys
    (`source`/`observation_ts`/`knowledge_ts`) are not factor inputs, and a `None`/non-numeric line item
    is OMITTED so the factor NaN-excludes a missing component rather than reading a fabricated 0 (the
    same contract `_to_factor_line_items` honours for the Yahoo path)."""
    out: dict[str, float] = {}
    for key in LINE_ITEMS:
        val = payload.get(key)
        if val is None:
            continue
        try:
            out[key] = float(val)
        except (TypeError, ValueError):
            # A non-numeric line item is dropped, not coerced — never a fabricated value.
            continue
    return out


# Live live-seam fundamentals provider modes (global.env.liveFundamentalsProvider). `yahoo` fully
# restores the pre-Task-14 behaviour (forward-only snapshot only); `pit` routes US/UK to the PIT
# warehouse with a Yahoo fallback. The default is `yahoo` (reversible, safe-by-default) — see
# build_fundamentals_provider.
PROVIDER_MODE_PIT = "pit"
PROVIDER_MODE_YAHOO = "yahoo"


class RoutingFundamentalsAsOf:
    """`FundamentalsAsOf` that routes each name to its jurisdiction's PIT source, falling back to the
    forward-only Yahoo snapshot on a miss/empty — the live wiring the epic's Task 14 installs.

    ROUTING (by `market_of(ticker)`):
      - `*_US_EQ` (US) and `*l_EQ` (UK)  → the PIT warehouse (`PitFundamentalsAsOf`), with a per-name
        Yahoo fallback when PIT has no fact for that name at `as_of_ms` (covered-but-unseeded, or a
        not-yet-ingested name). The fallback is LIVE-ONLY: it only ever fires for an ≈now `as_of_ms`,
        because `YahooFundamentalsAsOf` is itself forward-only and returns `{}` for a past as_of — so a
        backtest replay never gets a Yahoo proxy through this path (no look-ahead).
      - anything else (OTHER)            → Yahoo directly (no PIT jurisdiction to route to; the snapshot
        is global, forward-only).

    SOURCE STAMP — `source_for(ticker)` reports the source the name was ACTUALLY served from in the most
    recent `fetch_many`: the PIT stamp (`pit-edgar`/`pit-companies-house`) for a covered US/UK name, but
    `yahoo-snapshot` for a name that fell back to Yahoo (PIT had no fact for it) or an OTHER name. This is
    honest provenance — a Yahoo-fallback value is never mislabelled pit-*. It is safe because the host
    always calls `fetch_many` (which records the fallback set) before `source_for` within one cycle, and
    the cycle holds `_cycle_lock` (single-pod KEDA, ≤1 replica), so there is no interleaving. Before any
    fetch, `source_for` defaults to the routed jurisdiction's stamp (the expected/covered case).

    REVERSIBILITY — constructed only in `pit` mode (see `build_fundamentals_provider`); `yahoo` mode
    returns the bare `YahooFundamentalsAsOf`, so flipping `global.env.liveFundamentalsProvider` back to
    `yahoo` fully restores the pre-Task-14 behaviour with no code change.
    """

    def __init__(self, pit: FundamentalsAsOf, yahoo: FundamentalsAsOf) -> None:
        self._pit = pit
        self._yahoo = yahoo
        # Names served from the Yahoo fallback in the most recent fetch_many (so source_for reports the
        # source actually used, not the routed jurisdiction it would-have-used). Reset each fetch_many.
        self._fell_back_to_yahoo: set[str] = set()

    def source_for(self, ticker: str) -> str:
        """The source stamp for `ticker`: `yahoo-snapshot` if it was served from the Yahoo fallback (or
        is an OTHER name), else the routed PIT jurisdiction's stamp. Reflects the source ACTUALLY used in
        the last `fetch_many` (honest provenance for the factor_scores stamp + the re-backfill guard)."""
        if market_of(ticker) == MARKET_OTHER or ticker in self._fell_back_to_yahoo:
            return self._yahoo.source_for(ticker)
        return self._pit.source_for(ticker)

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Partition by jurisdiction, fetch PIT for the US/UK slice (one round-trip) + Yahoo for the
        OTHER slice, then fill PIT misses from Yahoo (live-only — forward-only Yahoo yields `{}` for a
        past as_of). The whole method is best-effort: each leg's provider already degrades to `{}` on
        failure, so a PIT outage simply leaves those names to the Yahoo fallback. Records which US/UK
        names fell back to Yahoo so `source_for` stamps them honestly."""
        self._fell_back_to_yahoo = set()
        if not tickers:
            return {}
        pit_names = [t for t in tickers if market_of(t) != MARKET_OTHER]
        other_names = [t for t in tickers if market_of(t) == MARKET_OTHER]

        out: dict[str, dict[str, float]] = {}
        if pit_names:
            out.update(await self._pit.fetch_many(pit_names, as_of_ms))
        # Yahoo covers the OTHER slice outright, plus any US/UK name PIT had no fact for (the fallback).
        # Forward-only Yahoo returns {} for a past as_of, so this never injects a proxy into replay.
        pit_misses = [t for t in pit_names if t not in out]
        yahoo_names = other_names + pit_misses
        if yahoo_names:
            yahoo_out = await self._yahoo.fetch_many(yahoo_names, as_of_ms)
            out.update(yahoo_out)
            # A US/UK name is a Yahoo-served fallback only if Yahoo actually returned it (≈now). A past
            # as_of yields {} from forward-only Yahoo, so it's not "served from Yahoo" — its cell stays
            # absent and the stamp keeps the (unused) PIT jurisdiction default; no proxy, no mislabel.
            self._fell_back_to_yahoo = {t for t in pit_misses if t in yahoo_out}
        return out

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name routed lookup over `fetch_many`."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


def build_fundamentals_provider(
    client: MarketDataClient,
    *,
    mode: str | None = None,
    pit_provider: FundamentalsAsOf | None = None,
) -> FundamentalsAsOf:
    """Construct the live FundamentalsAsOf seam from the configured provider mode (the wiring point
    the host calls at startup, replacing the bare `YahooFundamentalsAsOf(...)`).

    - `mode='yahoo'` (the SAFE DEFAULT) → the forward-only `YahooFundamentalsAsOf` alone — byte-for-byte
      the pre-Task-14 behaviour. This is the default because pre-backfill the PIT warehouse is empty, so
      routing through it buys nothing yet and Yahoo is the only live source; flipping the env to `pit` is
      the operator's deliberate, reversible opt-in once the backfill has landed rows.
    - `mode='pit'` → `RoutingFundamentalsAsOf(PIT, Yahoo)`: US/UK read the PIT warehouse with a Yahoo
      fallback, OTHER reads Yahoo. Reversible — flip back to `yahoo` to restore the bare snapshot.

    `mode` defaults to `LIVE_FUNDAMENTALS_PROVIDER` (env), then `yahoo`. `pit_provider` is injectable for
    tests (otherwise a `PitFundamentalsAsOf` over fundamentals-api is built)."""
    resolved = (mode or os.getenv("LIVE_FUNDAMENTALS_PROVIDER") or PROVIDER_MODE_YAHOO).strip().lower()
    yahoo = YahooFundamentalsAsOf(client)
    if resolved != PROVIDER_MODE_PIT:
        # Default + explicit `yahoo`: forward-only snapshot only (pre-Task-14 behaviour, reversible).
        return yahoo
    pit = pit_provider if pit_provider is not None else PitFundamentalsAsOf()
    return RoutingFundamentalsAsOf(pit, yahoo)
