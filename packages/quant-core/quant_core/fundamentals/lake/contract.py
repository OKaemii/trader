"""Platform contract layer — map a ``TickerIdentity`` to the byte-compatible ``line_items`` dict the
PIT fundamentals seam serves.

This is the single place that turns the lake's standardized PIT series (``store`` + ``metrics``) into
the exact snake_case ``line_items`` dict ``quant_core.fundamentals.contract.LINE_ITEMS`` pins — the
shape strategy-engine (`fundamentals_as_of.py`) and market-data-service (`PitFundamentalsProvider.ts`)
parse byte-for-byte. The read-API (Task 10) wraps this: it builds a ``TickerIdentity`` from each
request ticker, calls :func:`pit_line_items`, runs the Gap-2 enrichment (``market_cap_gbp`` +
``dividend_yield``), and serves ``{ticker: {<14 line_items>, source, observation_ts, knowledge_ts}}``.

THE THREE PIVOTS (the only fundamentals logic here):
  * **Flows → TTM-or-annual.** ``net_income`` / ``total_revenue`` / ``gross_profit`` / ``cash_flow_ops``
    prefer the latest trailing-twelve-month point (four consecutive quarters as-of), falling back to
    the latest annual when no TTM is derivable, else omitted. More current than a stale annual without
    losing PIT-safety (a derived TTM never surfaces before all four inputs were public — the
    ``filed = max(inputs)`` carry, enforced in ``metrics``).
  * **Instants → latest period_end ≤ as_of.** ``total_equity`` / ``total_assets`` /
    ``total_liabilities`` / ``current_assets`` / ``current_liabilities`` / ``total_debt`` /
    ``shares_outstanding`` take the last point of the instant series (the store already PIT-filters,
    so the last ``end`` is the most recent balance-sheet instant knowable at the cutoff).
  * **``earnings_stability`` (NEW leg).** Not produced by the old PIT path (Yahoo-only there), so no
    byte-compat constraint — computed here from the as-of ANNUAL ``net_income`` series as the inverse
    coefficient of variation (see :func:`earnings_stability`). Higher = steadier earnings, matching the
    ``QualityFactor`` contract sign.

FAIL-CLOSED, EVERYWHERE:
  * Non-US (``market != 'US'``) → ``({}, None, None, None)`` immediately. LSE/foreign names have no
    EDGAR presence and — per Thread C — there is NO Yahoo fallback; those legs are NaN-excluded
    downstream. The store would itself return None for a non-US ``resolve``, but short-circuiting here
    avoids the (pointless) resolve call.
  * An unresolved CIK (cold lake / unknown / private name) → ``({}, None, None, None)``.
  * A leg whose value is ``None`` is DROPPED from the dict — never coerced to ``0`` (a fabricated 0
    would corrupt a ratio; the factor NaN-excludes a missing key instead). This is the
    ``{k: v for k, v in … if v is not None}`` guard.

``market_cap_gbp`` and ``dividend_yield`` are deliberately NOT computed here — the read-API's Gap-2
enrichment (``market_cap.py`` + ``apply_dividend_yield``, Task 10) adds them from the as-of adjusted
close × shares × FX, off the ``shares_outstanding`` this layer supplies. Keys are the EXACT
``LINE_ITEMS`` spellings (imported, never re-listed, so the producer and the consumer cannot drift).

pyarrow + duckdb are only reached transitively through ``store`` (the ``quant-core[lake]`` extra); this
module itself is pure stdlib + the two lake submodules.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timezone

from quant_core.fundamentals.contract import LINE_ITEMS, SOURCE_PIT_EDGAR
from quant_core.fundamentals.lake.metrics import metric_series
from quant_core.ticker_identity import TickerIdentity

# Only US listings file with SEC EDGAR — the lake's sole jurisdiction. A non-US identity fails closed.
_EDGAR_MARKET = "US"

# The flow (income-statement / cash-flow) legs: pivoted to TTM-or-annual. Spelled identically to the
# `METRICS` keys (which are themselves the `LINE_ITEMS` spellings), so `metric_series` resolves each
# with no rename layer.
FLOW_METRICS: tuple[str, ...] = (
    "net_income",
    "total_revenue",
    "gross_profit",
    "cash_flow_ops",
)

# The instant (balance-sheet / cover-page) legs: the latest period_end ≤ as_of.
INSTANT_METRICS: tuple[str, ...] = (
    "total_equity",
    "total_assets",
    "total_liabilities",
    "current_assets",
    "current_liabilities",
    "total_debt",
    "shares_outstanding",
)

# `earnings_stability` is computed from the trailing annual net-income series over this many periods.
# 5 years balances "enough points for a meaningful dispersion" against "recent enough to reflect the
# current business" (a longer window drags in pre-pivot regimes). `< 3` annual points → None (too few
# to characterise variability honestly).
_EARNINGS_STABILITY_YEARS = 5
_EARNINGS_STABILITY_MIN_PERIODS = 3


def _as_of_date(as_of_ms: int) -> date:
    """The UTC calendar date of a knowledge cutoff, for ``store.resolve``.

    ``pit_line_items`` is handed ``as_of_ms`` — an epoch-ms ``int`` (the ``knowledge_ts`` axis the
    facts are filtered on). ``store.pit_series`` / ``metric_series`` consume that int directly. But
    ``store.resolve`` compares the cutoff against ``ticker_history``'s ``valid_from`` / ``valid_to``
    DATE columns (``date32``); binding the raw epoch-ms int there would compare a bigint to a date and
    silently mis-resolve the rename window. So the resolve cutoff is the int's UTC calendar date — a
    rename is dated to a calendar day, and "what symbol was this on day D" is the right question for
    identity (the ms-precise look-ahead guard is the store's `knowledge_ts` filter on the FACTS, which
    keeps its int axis)."""
    return datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc).date()


def _date_to_ms(d: date) -> int:
    """A period-end ``date`` → its UTC-ms epoch (00:00:00Z of that day) — the unit ``observation_ts``
    is reported in (matching the bars `observation_ts` convention: midnight-UTC of the period date)."""
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp() * 1000)


def _latest_point(store, cik: int, metric: str, freq: str, as_of_ms: int) -> dict | None:
    """The last (most recent ``end``) point of a metric's as-of series, or None when the series is
    empty. ``metric_series`` already returns points sorted by ``end`` ascending and PIT-filtered by the
    store, so the final element is the most recent value knowable at the cutoff. A point is the full
    dict (``value`` / ``start`` / ``end`` / ``filed`` / ``accession`` / ``form`` and — for
    non-derived rows — ``knowledge_ts``), so callers can read provenance off it, not just the value."""
    points = metric_series(store, cik, metric, freq, as_of_ms)["points"]
    return points[-1] if points else None


def ttm_or_annual(store, cik: int, metric: str, as_of_ms: int) -> dict | None:
    """A flow leg's representative point: prefer the latest TTM, fall back to the latest annual, else
    None.

    Returns the chosen POINT (not the bare value) so the caller can read its ``value`` AND its
    provenance (``end`` for ``observation_ts``, ``knowledge_ts`` when present for ``knowledge_ts``).
    TTM is the more-current view (a name a few months past its fiscal year-end has a fresher trailing
    figure than its last annual) and is PIT-safe — ``metrics.ttm`` carries ``filed = max(inputs)`` so a
    derived TTM never appears before all four quarters were public. A name with < 4 consecutive
    quarters as-of (or non-additive) yields no TTM → annual fallback; a name with neither → None →
    the leg is omitted by the caller."""
    ttm = _latest_point(store, cik, metric, "ttm", as_of_ms)
    if ttm is not None:
        return ttm
    return _latest_point(store, cik, metric, "a", as_of_ms)


def latest_instant(store, cik: int, metric: str, as_of_ms: int) -> dict | None:
    """An instant (balance-sheet / cover-page) leg's representative point: the latest period_end ≤
    as_of, or None. ``freq`` is irrelevant for an instant metric (``metric_series`` ignores it for
    STOCK kinds), so any value is fine — ``"q"`` chosen arbitrarily. Returns the full point for the
    same provenance reason as :func:`ttm_or_annual`."""
    return _latest_point(store, cik, metric, "q", as_of_ms)


def earnings_stability(store, cik: int, as_of_ms: int) -> float | None:
    """Inverse coefficient of variation of annual net income — a higher value = steadier earnings.

    Definition (note 5 of the plan): over the last ``_EARNINGS_STABILITY_YEARS`` (5) as-of ANNUAL
    ``net_income`` points,

        earnings_stability = mean(net_income) / stddev(net_income)

    using the **population** standard deviation (``ddof = 0``: divide by N, not N-1). The choice is
    documented and unit-tested — population stddev is the right denominator here because the 5 annual
    observations are treated as the complete window being characterised, not a sample drawn from a
    larger population; it is also defined for the N = 3 floor (a sample stddev with ddof = 1 over 3
    points divides by 2, inflating the figure, and the inverse-CV is a relative dispersion measure
    where the population form is the natural one). Returns ``None`` when:
      * fewer than ``_EARNINGS_STABILITY_MIN_PERIODS`` (3) annual points are knowable as-of — too few
        to characterise dispersion honestly; or
      * the stddev is zero (perfectly flat earnings) — the inverse-CV would be a division by zero
        (∞), which is meaningless as a "stability" score; None is the fail-closed value (the factor
        NaN-excludes it, never a fabricated number).

    Uses ONLY annual points ≤ as_of (the store's `knowledge_ts` filter guarantees no look-ahead), so
    this leg is PIT-correct by the same axis as every other. The MEAN is signed (a name with genuinely
    negative average earnings yields a negative stability, correctly penalising it under the
    QualityFactor sign); only the magnitude of the stddev governs the dispersion penalty.
    """
    annual = metric_series(store, cik, "net_income", "a", as_of_ms)["points"]
    # The trailing N annual periods (the series is sorted by `end` ascending → take the tail).
    values = [p["value"] for p in annual[-_EARNINGS_STABILITY_YEARS:]]
    if len(values) < _EARNINGS_STABILITY_MIN_PERIODS:
        return None
    n = len(values)
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / n  # population (ddof = 0)
    stddev = math.sqrt(variance)
    if stddev == 0:
        return None
    return mean / stddev


def pit_line_items(
    store, ident: TickerIdentity, as_of_ms: int
) -> tuple[dict[str, float], str | None, int | None, int | None]:
    """Map a ``TickerIdentity`` to the byte-compatible PIT ``line_items`` dict, as of a knowledge
    instant.

    Returns ``(line_items, source, observation_ts, knowledge_ts)``:

      * ``line_items`` — the snake_case dict (keys ⊆ ``LINE_ITEMS``), fail-closed: a leg that did not
        resolve is ABSENT (never 0). The 12 raw legs (4 flows + 7 instants + ``earnings_stability``)
        are assembled here; ``market_cap_gbp`` / ``dividend_yield`` are added by the read-API's Gap-2
        enrichment (Task 10), so a fully-covered name returns 13 keys here (the API adds the final 2).
      * ``source`` — ``"pit-edgar"`` when ANY leg resolved, else ``None`` (a covered-but-empty read,
        e.g. a CIK that exists but has no facts knowable as-of, stamps ``None`` like a miss).
      * ``observation_ts`` — the period_end (UTC ms, midnight-UTC of the day) of the REPRESENTATIVE
        leg: ``net_income``'s chosen point if it resolved, else the first resolved leg in assembly
        order. This is the "as-of which fiscal period" stamp the seam carries; a flow's TTM point
        ``end`` is the latest quarter's period-end, an annual's is the fiscal year-end.
      * ``knowledge_ts`` — the MAX ``knowledge_ts`` across the chosen legs that report one (instant +
        annual-flow points carry it; a TTM/derived-Q4 flow point does not — ``metrics`` builds those
        as fresh dicts without the field). The max is the latest instant at which the WHOLE bundle was
        knowable — conservative and look-ahead-safe. ``None`` only if no chosen leg carried one (a
        TTM-only flow read with no instant legs — not a real covered name, since a covered US filer
        always has balance-sheet instants).

    Non-US or unresolved → ``({}, None, None, None)`` (fail-closed; no EDGAR, no Yahoo).
    """
    if ident.market != _EDGAR_MARKET:
        return {}, None, None, None  # LSE/foreign: no EDGAR, no Yahoo fallback (Thread C)

    ent = store.resolve(ident.symbol, ident.market, _as_of_date(as_of_ms))
    if ent is None:
        return {}, None, None, None  # cold lake / unknown / private name
    cik = ent["cik"]

    # Assemble the legs, keeping each chosen POINT (not just its value) so observation_ts/knowledge_ts
    # can be derived from the representative legs' provenance.
    points: dict[str, dict] = {}
    for m in FLOW_METRICS:
        p = ttm_or_annual(store, cik, m, as_of_ms)
        if p is not None:
            points[m] = p
    for m in INSTANT_METRICS:
        p = latest_instant(store, cik, m, as_of_ms)
        if p is not None:
            points[m] = p

    line_items: dict[str, float] = {m: p["value"] for m, p in points.items()}

    es = earnings_stability(store, cik, as_of_ms)
    if es is not None:
        line_items["earnings_stability"] = es

    # Fail-closed omission: drop any leg whose value is None — never coerce to 0. (The dict-comp above
    # already excludes legs whose POINT was None; this guards a leg whose resolved point carried a
    # None value, and is the literal contract the plan pins.)
    line_items = {k: v for k, v in line_items.items() if v is not None}

    if not line_items:
        return {}, None, None, None  # covered CIK but nothing knowable as-of → a miss

    # observation_ts: the representative leg's period_end. Prefer net_income (the canonical earnings
    # anchor the value/quality factors centre on); else the first leg that resolved, in assembly order.
    rep = points.get("net_income")
    if rep is None:
        rep = next((points[m] for m in (*FLOW_METRICS, *INSTANT_METRICS) if m in points), None)
    observation_ts = _date_to_ms(rep["end"]) if rep is not None else None

    # knowledge_ts: the max knowledge_ts across chosen legs that report one (TTM/derived flows omit it;
    # instant + annual-flow points carry it). None only if no chosen leg carried one.
    kts = [p["knowledge_ts"] for p in points.values() if p.get("knowledge_ts") is not None]
    knowledge_ts = max(kts) if kts else None

    return line_items, SOURCE_PIT_EDGAR, observation_ts, knowledge_ts


# A defensive sanity check that every metric this layer assembles is a real `LINE_ITEMS` member (so a
# typo in FLOW_METRICS/INSTANT_METRICS that didn't match a `METRICS` key would still be caught here as
# "not in the contract vocabulary"). `earnings_stability` is the contract-layer-computed leg; the
# enriched market_cap_gbp/dividend_yield are added by the API. Run at import — a drift fails loudly.
assert set(FLOW_METRICS) | set(INSTANT_METRICS) | {"earnings_stability"} <= set(LINE_ITEMS), (
    "contract assembles a key outside LINE_ITEMS"
)
