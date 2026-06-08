"""WarehousePitFundamentals — the REPLAY point-in-time fundamentals source (DuckDB warehouse).

This is the offline twin of the live `fundamentals-api` resolver: the SAME bi-temporal as-of read
and the SAME `price × shares × fx` market-cap identity (plan Design §6 / §8, Task 12's note), but run
over the DuckDB `fundamentals` + `bars` warehouse views, NOT the live HTTP/Redis path — replay must
never reach into the metered, in-cluster live services. quant-core is the single source of truth
shared by live and replay, so the contract (`FundamentalsAsOf`, `LINE_ITEMS`, `source_for`) is the
same; only the STORE differs.

NO-LOOK-AHEAD IN SQL (the hard constraint, identical to the live resolver). The `knowledge_ts <= ?`
predicate lives in the query — a fact from a filing made knowable after `as_of` is never returned
because the database never hands it to us. There is no app-layer date filter a refactor could drop.

AS-OF SHAPE. For each `(instrument_id, metric, observation_ts, dim_signature)` we pick the latest
revision with `knowledge_ts <= as_of` (`ROW_NUMBER() … PARTITION BY … ORDER BY knowledge_ts DESC`,
`rn = 1`) — DuckDB's equivalent of the live resolver's `DISTINCT ON`. Consolidated only
(`dim_signature = ''`); segment facts are excluded from the canonical line-item dict. Restatements
are handled by the as-of pick: an original first-print and a later restatement of the same fiscal
period are two rows with different `knowledge_ts`, and an as-of read at the original date returns the
first-print (the restatement's `knowledge_ts` is in the future, filtered out).

PERIOD SELECTION + THE INVESTMENT LEGS. The factors want the latest *annual* figure knowable as-of, so
per metric we keep the greatest-`observation_ts` value → the snake_case line-item dict. InvestmentFactor
additionally needs the YoY *prior* annual value for `total_assets`/`total_equity`, so we also surface
the SECOND-greatest annual observation under the `_prev` suffix (`total_assets_prev`,
`total_equity_prev`). `_prev` is a reader-side derivation key, deliberately NOT a `LINE_ITEMS` member
(the contract pins the canonical *current* vocabulary); the InvestmentFactor reads it, and the
forward-only Yahoo provider — which can't supply a prior annual observation — simply omits it (those
names NaN-exclude from the investment cross-section, never a fabricated proxy).

MARKET CAP (Gap 2, Task 12's identity, off the WAREHOUSE bars view). `market_cap_gbp` is COMPUTED
point-in-time — never a provider scalar — as `adjusted_close(as_of) × shares_outstanding(as_of) ×
fx_to_gbp`, where the close is the latest daily bar at/<= as_of from the same DuckDB `bars` view
momentum reads (`bar.close` is the persisted adjusted_close), `shares_outstanding` is the as-of dei
fact, and `fx_to_gbp` is injected (see below). It OVERRIDES any warehouse `market_cap_gbp` fact and is
DROPPED (key absent) when any input is missing — the factor NaN-excludes it, never a 0.

FX IS INJECTED, not sourced here. quant-core has no FX layer (no Redis, no upstream) — and the live
identity takes `fx_to_gbp_rate` as a pure parameter (`fundamentals-api`'s `compute_market_cap_gbp`).
So `fx_to_gbp` is a caller-supplied `currency -> Optional[rate]` callable (GBP-per-1-unit of the
listing currency). The default resolves GBP→1.0 (LSE closes are pence-killed to GBP at the market-data
boundary, so an LSE name's market cap is fully computable in replay) and every other currency → None
(market cap absent for that name until the backtest host injects an FX series — Task 15). This mirrors
`fundamentals-api`'s documented reuse: FX is a second-order effect on a *cross-sectional* Value rank
(every USD name shares the multiplier, so the rank is invariant to it).

INSTRUMENT RESOLUTION IS INJECTED. The `fundamentals` PK keys on `instrument_id`, but callers speak
T212 tickers. The warehouse `security_master` resolution is the snapshotter/backtest-host concern
(Task 15 wires it), so this reader takes a `resolve_instrument(ticker, as_of_ms) -> Optional[int]`
callable, keeping the reader pure and unit-testable with no security-master snapshot. An unresolved
ticker, or a covered ticker with no fact ≤ as_of, yields `{}` for that name — never a fabricated value.

DuckDB is the `quant-core[warehouse]` optional extra, imported lazily — the live host (strategy-engine)
never pulls it.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from .contract import (
    LINE_ITEMS,
    MARKET_UK,
    MARKET_US,
    SOURCE_PIT_COMPANIES_HOUSE,
    SOURCE_PIT_EDGAR,
    market_of,
)

log = logging.getLogger("quant_core.fundamentals.warehouse")

# The line item we OWN the computation of (price × shares × fx) — overrides any warehouse fact.
_MARKET_CAP_KEY = "market_cap_gbp"
_SHARES_KEY = "shares_outstanding"

# Balance-sheet metrics whose PRIOR annual observation the InvestmentFactor reads via `<key>_prev`.
# Kept narrow on purpose: only the YoY-growth legs need a second observation; everything else is a
# single latest-as-of value, so we don't bloat the per-ticker dict with prior values nothing reads.
_PREV_METRICS = ("total_assets", "total_equity")
_PREV_SUFFIX = "_prev"

# As-of read: latest revision per logical fact with knowledge_ts <= as_of, consolidated only. The
# NO-LOOK-AHEAD GUARD is the `knowledge_ts <= ?` clause — in SQL, never in app code. We order by
# observation_ts DESC inside each metric so the row scan yields newest-first, and pick the top TWO
# distinct annual observations per metric in Python (current + prior, for the YoY legs).
_SELECT_AS_OF = """
SELECT metric, observation_ts, value
FROM (
  SELECT metric, observation_ts, value,
         ROW_NUMBER() OVER (
           PARTITION BY instrument_id, metric, observation_ts, dim_signature
           ORDER BY knowledge_ts DESC
         ) AS rn
  FROM fundamentals
  WHERE instrument_id = ?
    AND knowledge_ts <= ?
    AND dim_signature = ''
) sub
WHERE rn = 1
ORDER BY metric, observation_ts DESC
"""

# As-of adjusted close: latest daily bar at/<= as_of, bi-temporal (a later-revised close is invisible
# before its knowledge_ts). `close` IS the persisted adjusted_close (the series momentum differences).
_SELECT_CLOSE_AS_OF = """
SELECT close
FROM (
  SELECT close, observation_ts, ROW_NUMBER() OVER (
           PARTITION BY observation_ts ORDER BY knowledge_ts DESC
         ) AS rn
  FROM bars
  WHERE ticker = ?
    AND interval = 'daily'
    AND observation_ts <= ?
    AND knowledge_ts <= ?
) sub
WHERE rn = 1
ORDER BY observation_ts DESC
LIMIT 1
"""


def _default_fx_to_gbp(currency: Optional[str]) -> Optional[float]:
    """GBP-per-1-unit of `currency`, replay default: GBP → identity (1.0), anything else → None.

    LSE closes are pence-killed to GBP at the market-data boundary, so a GBP name's market cap is
    fully computable off the warehouse with no FX series. A USD (or other) name needs a real rate the
    backtest host injects (Task 15); absent it, the name's market cap is genuinely unavailable here —
    None, never a guessed 1.0 (which would treat USD as GBP and distort the Value cross-section)."""
    if currency == "GBP":
        return 1.0
    return None


def _currency_of(ticker: str) -> Optional[str]:
    """Listing currency by T212 suffix — the multiplier's currency for FX→GBP. Mirrors
    `fundamentals-api`'s `currency_of`: `*_US_EQ` → USD; `*l_EQ` → GBP (already pence-killed);
    unroutable → None (no FX basis ⇒ market cap absent)."""
    m = market_of(ticker)
    if m == MARKET_US:
        return "USD"
    if m == MARKET_UK:
        return "GBP"
    return None


class WarehousePitFundamentals:
    """`FundamentalsAsOf` over the DuckDB warehouse — the replay PIT source (plan Design §6).

    Implements the relocated `FundamentalsAsOf` Protocol (`fetch_many` / `fetch` / `source_for`) so it
    drops into the same seam the live providers use; replay calls `fetch_many(tickers, as_of_ms)` at
    each step. Holds a DuckDB connection with `fundamentals` + `bars` views registered (the backtest
    `WarehouseReader` registers them; for unit tests an in-memory connection with those views suffices).

    Injection points keep it pure + deps-light:
      - `resolve_instrument(ticker, as_of_ms) -> Optional[int]` — ticker → instrument_id (security
        master is the host's concern; default returns None ⇒ every name unresolved ⇒ `{}`).
      - `fx_to_gbp(currency) -> Optional[float]` — GBP-per-1-unit multiplier (default: GBP identity,
        else None).
    """

    def __init__(
        self,
        con,
        *,
        resolve_instrument: Optional[Callable[[str, int], Optional[int]]] = None,
        fx_to_gbp: Optional[Callable[[Optional[str]], Optional[float]]] = None,
    ) -> None:
        self._con = con
        self._resolve = resolve_instrument or (lambda _ticker, _as_of: None)
        self._fx = fx_to_gbp or _default_fx_to_gbp

    def source_for(self, ticker: str) -> str:
        """The PIT `source` stamp a covered name carries, by jurisdiction — UK → Companies House,
        else US EDGAR (mirror the live `source_for`)."""
        return SOURCE_PIT_COMPANIES_HOUSE if market_of(ticker) == MARKET_UK else SOURCE_PIT_EDGAR

    async def fetch(self, ticker: str, as_of_ms: int) -> dict[str, float]:
        """Single-name as-of line items, or `{}` if the name is unresolved / has no fact ≤ as_of."""
        out = await self.fetch_many([ticker], as_of_ms)
        return out.get(ticker, {})

    async def fetch_many(self, tickers: list[str], as_of_ms: int) -> dict[str, dict[str, float]]:
        """As-of line-item dicts keyed by ticker (knowledge_ts ≤ as_of, consolidated). Names with no
        resolvable instrument or no fact ≤ as_of are ABSENT from the map (the forward-only degrade —
        the caller's reader then leaves them `{}`, never a proxy). The computed PIT market cap is
        added when price+shares+fx are all available; otherwise the key is dropped (NaN-excluded)."""
        out: dict[str, dict[str, float]] = {}
        for ticker in tickers:
            instrument_id = self._resolve(ticker, as_of_ms)
            if instrument_id is None:
                continue
            line_items = self._fundamentals_for(int(instrument_id), as_of_ms)
            if not line_items:
                continue
            self._apply_market_cap(ticker, line_items, as_of_ms)
            out[ticker] = line_items
        return out

    # --- internals -------------------------------------------------------------------------------

    def _fundamentals_for(self, instrument_id: int, as_of_ms: int) -> dict[str, float]:
        """Pivot the as-of facts for one instrument into the snake_case line-item dict, latest annual
        observation per metric, plus the prior-year value under `<key>_prev` for the YoY legs."""
        # Degrade to {} if the `fundamentals` view is missing/stub-typed (a never-backfilled warehouse
        # registers an empty placeholder view with no fact columns, so the as-of SELECT can't bind).
        # The forward-only degrade is the contract: an uncovered name arrives `{}` to the strategy,
        # never a fabricated value. Mirrors the bars-read guard in `_adjusted_close_as_of` below.
        try:
            rows = self._con.execute(_SELECT_AS_OF, [instrument_id, as_of_ms]).fetchall()
        except Exception as exc:  # noqa: BLE001 — a missing/empty fundamentals view must not break replay
            log.warning("warehouse fundamentals read failed for instrument %s: %r", instrument_id, exc)
            return {}
        # rows arrive ordered (metric, observation_ts DESC) → newest-first within each metric.
        latest: dict[str, float] = {}
        prev: dict[str, float] = {}
        seen_obs: dict[str, set[int]] = {}
        for metric, obs_ts, value in rows:
            if metric not in LINE_ITEMS or value is None:
                continue
            obs = int(obs_ts)
            observed = seen_obs.setdefault(metric, set())
            if metric not in latest:
                latest[metric] = float(value)
                observed.add(obs)
            elif metric in _PREV_METRICS and metric not in prev and obs not in observed:
                # Second DISTINCT annual observation for a growth metric → the prior-year value.
                prev[metric] = float(value)
                observed.add(obs)
        line_items: dict[str, float] = dict(latest)
        for metric, value in prev.items():
            line_items[f"{metric}{_PREV_SUFFIX}"] = value
        return line_items

    def _apply_market_cap(self, ticker: str, line_items: dict[str, float], as_of_ms: int) -> None:
        """Compute PIT market cap (price × shares × fx) off the warehouse bars view and OVERRIDE any
        provider scalar; DROP the key when any input is missing (never a fabricated 0)."""
        # Short-circuit before the bars query + FX lookup: no shares ⇒ no honest market cap, so skip
        # the per-name DuckDB close read on the replay hot path (called per step × per name) and drop
        # any stale provider scalar. The FX basis (currency) is also absent for OTHER-market names,
        # but shares is the cheapest gate (already in hand from the pivot).
        shares = line_items.get(_SHARES_KEY)
        if shares is None:
            line_items.pop(_MARKET_CAP_KEY, None)
            return
        close = self._adjusted_close_as_of(ticker, as_of_ms)
        fx_rate = self._fx(_currency_of(ticker))
        cap = _compute_market_cap_gbp(close, shares, fx_rate)
        if cap is None:
            line_items.pop(_MARKET_CAP_KEY, None)
        else:
            line_items[_MARKET_CAP_KEY] = cap

    def _adjusted_close_as_of(self, ticker: str, as_of_ms: int) -> Optional[float]:
        """Latest daily adjusted close at/<= as_of from the warehouse `bars` view (bi-temporal)."""
        try:
            row = self._con.execute(
                _SELECT_CLOSE_AS_OF, [ticker, as_of_ms, as_of_ms]
            ).fetchone()
        except Exception as exc:  # noqa: BLE001 — a missing/empty bars view must not break the read
            log.warning("warehouse market-cap close read failed for %s: %r", ticker, exc)
            return None
        if not row or row[0] is None:
            return None
        return float(row[0])


def _compute_market_cap_gbp(
    adjusted_close: Optional[float],
    shares_outstanding: Optional[float],
    fx_to_gbp_rate: Optional[float],
) -> Optional[float]:
    """The PIT market-cap identity, pure: adjusted_close × shares_outstanding × fx_to_gbp_rate (GBP).

    Returns None when ANY input is missing/non-finite/non-positive — a market cap with no honest
    price, share count, or FX rate is genuinely unavailable, so the line item is absent (NaN-excluded
    by the factor) rather than a fabricated 0. Identical semantics to `fundamentals-api`'s
    `compute_market_cap_gbp` (live + replay share ONE identity, different store for the inputs)."""
    import math

    for x in (adjusted_close, shares_outstanding, fx_to_gbp_rate):
        if x is None or not math.isfinite(x) or x <= 0:
            return None
    return adjusted_close * shares_outstanding * fx_to_gbp_rate
