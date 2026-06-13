"""FundamentalsAsOf — the point-in-time (PIT) fundamentals seam (strategy-engine side).

This is the socket the research-factor layer reads through. The host fills
`HistoryView.fundamentals[ticker]` from a `FundamentalsAsOf` provider, so the factor code
(`quant_core.strategy.factors` QualityFactor / ValueFactor) never learns where the numbers came
from — it just consumes a snake_case line-item dict.

CONTRACT MOVED TO quant-core. The canonical pieces every side agrees on — the snake_case
`LINE_ITEMS` key set, the `FundamentalsAsOf` Protocol, the `SOURCE_*` stamps, and the `MARKET_*` /
`market_of()` router — live in `quant_core.fundamentals.contract` (read by both live and replay; one
source of truth so the readers cannot drift). They are RE-EXPORTED from this module unchanged, so
every existing import path (`from src.infrastructure.fundamentals_as_of import FundamentalsAsOf,
market_of, SOURCE_*, MARKET_*`) keeps working.

SINGLE SOURCE, FAIL-CLOSED (epic pit-fundamentals-lake-rearchitecture, Thread C + decision H):
The seam reads ONLY the PIT lake (SEC EDGAR), served by fundamentals-api. There is **no Yahoo
fallback** anywhere on this path:
  - a US (`*_US_EQ`) name resolves from the lake, as-of the cycle's knowledge-time;
  - a non-US name (LSE / anything else) is FAIL-CLOSED to `{}` — there is no EDGAR for it and we do
    not substitute Yahoo (decision H). Its Quality + earnings/book Value legs are then NaN-excluded
    downstream (the name ranks on price/momentum factors alone);
  - a US name the lake has no fact for ≤ as_of (a miss) is also `{}` — omitted, never proxied.
This makes the provenance reduce to `pit-edgar` | `null` (the `yahoo-snapshot` stamp is retired from
the live path; the constant stays defined in the shared contract for historical `factor_scores`
rows). Fundamentals are point-in-time-honest by construction: a past `as_of_ms` is answered from the
lake's `knowledge_ts <= as_of` filter — never a forward-only snapshot that would leak look-ahead.

Return shape — the snake_case line items the factors read off `HistoryView.fundamentals[t]`
(keys drawn from `quant_core.fundamentals.LINE_ITEMS`; QualityFactor: net_income, total_equity,
gross_profit, total_revenue, total_debt, earnings_stability; ValueFactor: dividend_yield,
net_income, total_equity, market_cap_gbp). A field the lake doesn't carry for a name is simply
absent (the factor z-scores over the names that have it; a missing component is NaN-excluded, never
a false 0). An empty dict means "no PIT fundamentals for this name/as-of" — the fail-closed signal.
"""

from __future__ import annotations

import os

import httpx

# Single source of truth for internal-JWT minting (mirrors shared-auth/internal-jwt.ts) — the PIT
# seam authenticates to fundamentals-api as `strategy-engine`, the same caller the bars/fundamentals
# in-cluster routes already authorize.
from quant_core.http.internal_jwt import mint_internal_jwt

# Re-export the canonical contract from quant-core so existing imports of these names from this
# module keep resolving (back-compat). The single source of truth is quant_core.fundamentals.
# SOURCE_YAHOO_SNAPSHOT is re-exported for the historical factor_scores rows that still carry it; no
# live path in this module emits it any more (Thread C — Yahoo removed from the seam).
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

# fundamentals-api in-cluster base URL (the read-side of the PIT lake). Port 8011, the seam hot path
# /internal/api/fundamentals-pit (camelCase asOf — the bars/pg-bar-reader convention; the headline
# /pit admin route uses as_of). Overridable for tests / non-default deploys.
_DEFAULT_FUNDAMENTALS_API_URL = "http://fundamentals-api:8011"
_PIT_CALLER = "strategy-engine"
_PIT_TIMEOUT_SECONDS = 10.0


class PitFundamentalsAsOf:
    """Point-in-time `FundamentalsAsOf` backed by the PIT fundamentals lake (fundamentals-api).

    The ONLY fundamentals source on the live seam (Thread C — Yahoo removed). It answers any past
    `as_of_ms` by reading the per-CIK Parquet lake through fundamentals-api's
    `/internal/api/fundamentals-pit?tickers=&asOf=` (the no-look-ahead guard lives in that service —
    `knowledge_ts <= asOf`). It returns the snake_case `LINE_ITEMS` dict the Quality/Value factors
    read off `HistoryView.fundamentals[t]`, with `market_cap_gbp` already the Gap-2 computed
    price×shares×fx value for covered names and the PIT `dividend_yield` leg merged in by the API.

    FAIL-CLOSED ROUTING (decision H):
      - US (`*_US_EQ`) names are sent to the lake.
      - non-US (LSE `*l_EQ`, anything else) are NOT sent — they fail-closed to `{}` directly (no
        EDGAR for them, no Yahoo substitute). This is both correct and a saved round-trip: the lake
        already returns `{}` for a non-US name, but routing here keeps the contract explicit and the
        request payload US-only.
    A US name the lake has no fact for ≤ asOf is simply ABSENT from the result map (a miss → `{}`),
    never proxied.

    LIVE SAFETY — the single most important property: this NEVER throws into the cycle. fundamentals-api
    being down, slow, 503 (cold lake), or returning malformed JSON all degrade to `{}` for the whole
    slice (logged once). With no fallback, that means those names get no fundamentals this cycle (their
    Quality/Value legs NaN-exclude) — the strategy's signal-emission path must not depend on a
    research-fundamentals service being reachable, and now it depends on nothing else either.

    SOURCE STAMP — `source_for(ticker)` is `pit-edgar` for every US name (the only jurisdiction the
    lake serves). It is reported regardless of whether the lake actually had a fact: a name with no
    fact produces a `None` quality factor, which `stamp_factor_sources` records as a no-source cell —
    so the stamp is never attached to an uncomputed factor (no fabricated provenance).

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
        """The PIT source stamp persisted alongside each factor this provider feeds: `pit-edgar`
        (SEC EDGAR — the only jurisdiction the lake serves). A non-US name is never served (fail-
        closed `{}`), so its quality/value factors are `None` and `stamp_factor_sources` records a
        no-source cell — the `pit-edgar` default is never attached to an uncomputed factor."""
        return SOURCE_PIT_EDGAR

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """Batch PIT lookup — one round-trip for the US slice the seam is asked for. Non-US names are
        fail-closed to `{}` and never sent. Returns each US name's line-item dict as known at
        `as_of_ms`; names the lake has no fact for ≤ asOf are ABSENT from the map (a miss → no
        fundamentals this cycle, no fallback). Any transport / lake / parse failure returns `{}` for
        the slice (logged once) — never raised into the cycle."""
        us_names = [t for t in tickers if market_of(t) == MARKET_US]
        if not us_names:
            # non-US only (or empty) → fail-closed, no round-trip.
            return {}
        url = (
            f"{self._base_url}/internal/api/fundamentals-pit"
            f"?tickers={','.join(us_names)}&asOf={int(as_of_ms)}"
        )
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                r = await client.get(url, headers=self._auth_header())
                r.raise_for_status()
                payload = r.json()
            # Parse + project INSIDE the try: a structurally-malformed-but-JSON-valid payload (a name
            # mapping to a non-dict, `fundamentals` not a dict) must also degrade to {}, not raise — the
            # live cycle can't trust the upstream shape never regresses (the whole "parse failure → {}").
            out: dict[str, dict[str, float]] = {}
            for ticker, tf in (payload.get("fundamentals") or {}).items():
                line_items = _pit_line_items(tf)
                if line_items:  # empty line-item dict = "no PIT fact for this name" → omit (no fallback)
                    out[ticker] = line_items
            return out
        except Exception as exc:  # noqa: BLE001 — the live cycle must never break on a PIT outage/parse
            if not self._warned:
                print(
                    f"[strategy-engine:pit-fundamentals] read failed (fail-closed, no fallback): {exc!r}",
                    flush=True,
                )
                self._warned = True
            return {}

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name PIT lookup over `fetch_many`. `{}` when non-US or the lake has no fact ≤ asOf."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})


def _pit_line_items(payload: dict) -> dict[str, float]:
    """Project one ticker's fundamentals-api payload onto the snake_case `LINE_ITEMS` the factors read.

    The seam payload per name is `{ <line items>, source, observation_ts, knowledge_ts }` (the resolver
    already emits the canonical snake_case keys via the shared contract — see fundamentals-api
    `resolver.py`). We keep only the `LINE_ITEMS` keys with a FINITE numeric value: the provenance keys
    (`source`/`observation_ts`/`knowledge_ts`) are not factor inputs, and a `None`/non-numeric line item
    is OMITTED so the factor NaN-excludes a missing component rather than reading a fabricated 0."""
    if not isinstance(payload, dict):
        # A name mapping to a non-dict (malformed payload) carries no line items — never crash on it.
        return {}
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


# Live-seam fundamentals provider mode (global.env.liveFundamentalsProvider). After Thread C the seam
# is PIT-only — `pit` is the sole behaviour (`yahoo` is retired: there is no forward-only snapshot
# fallback left to flip to). The constant + resolver stay so the observability endpoint and the
# startup wiring share one vocabulary, and an explicit/legacy `yahoo` env value (or any other) resolves
# to `pit` rather than erroring on a stale config.
PROVIDER_MODE_PIT = "pit"


def resolve_provider_mode(mode: str | None = None) -> str:
    """The SINGLE source of truth for the live fundamentals provider mode.

    After the Yahoo removal there is exactly ONE mode: `pit` (the PIT lake via fundamentals-api). This
    resolver always returns `PROVIDER_MODE_PIT` — it survives a stale `LIVE_FUNDAMENTALS_PROVIDER=yahoo`
    in an un-updated environment (the `yahoo` option is gone; the value is now inert) by treating any
    value as `pit`. It is kept (rather than inlined) so both `build_fundamentals_provider` (the startup
    wiring) and the observability endpoint (`GET /admin/api/strategy/fundamentals-source`) report the
    same mode, and so the seam's mode handling has one home if a second jurisdiction source is ever
    added."""
    return PROVIDER_MODE_PIT


def build_fundamentals_provider(
    *,
    pit_provider: FundamentalsAsOf | None = None,
) -> FundamentalsAsOf:
    """Construct the live FundamentalsAsOf seam — the wiring point the host calls at startup.

    PIT-only (Thread C): always the `PitFundamentalsAsOf` over fundamentals-api (US → the lake,
    non-US → fail-closed `{}`). There is no Yahoo fallback and no `yahoo` mode to select — the seam
    depends solely on the PIT lake. `pit_provider` is injectable for tests; otherwise a
    `PitFundamentalsAsOf` is built. Takes no `MarketDataClient` any more (the removed Yahoo impl was
    its only consumer here)."""
    return pit_provider if pit_provider is not None else PitFundamentalsAsOf()
