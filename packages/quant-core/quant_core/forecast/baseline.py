"""Seasonal random-walk (no-drift) annual-EPS baseline — the accuracy FLOOR every forecaster beats.

The first member of the analyst-free forecast ensemble and its benchmark: the walk-forward harness
drops any cross-sectional / market-implied model that cannot beat this baseline out-of-sample in a
region (plan ``analyst-free-estimates-engine.md`` Task 3; research §"Seasonal RW baseline"). Pure +
fail-closed, mirroring ``screen/quality.py``: a leg we don't have is never coerced to a number, so a
name we can't forecast honestly returns ``None`` (omitted), never a fabricated zero.

Why a NO-DRIFT random walk for ANNUAL EPS (the design contract, not a simplification):

  * Bradshaw et al. (2012) — the no-drift form (``EPS[t+τ] = EPS[t]``) BEATS the with-drift form
    (``EPS[t] + τ·trend``) for annual EPS; extrapolating a per-year trend adds noise, not signal. So
    the forecast is the latest as-of annual EPS, identical across every horizon τ — there is no drift
    term by design. ("Embarrassingly competitive" is the LONG-horizon annual result — the RW strongly
    dominates analysts at 3y, ~coin-flip at 2y; analysts only win the next-QUARTER horizon, which this
    annual baseline does not address.)
  * As-reported, split-adjusted EPS. "As-reported" = the figures the lake actually harvested
    (``net_income`` ÷ shares), no analyst normalization. "Split-adjusted" = every fiscal year's EPS is
    expressed on the SAME current share count, so a stock split between two years does not inject a
    spurious 2×/½× discontinuity into the series (see ``_split_adjusted_eps`` below).
  * Exclude a negative base-year. After a loss the latest annual EPS is ≤ 0; a random walk off a loss
    is not a meaningful earnings forecast (and the downstream growth leg is undefined — the brief
    reports the ROA trajectory instead, elsewhere). Fail-closed: a ≤ 0 base year → ``None``.
  * Return ``None`` when history is too thin. With no knowable annual earnings point as-of the date (a
    cold/young/non-US name), there is nothing to walk forward — omit it, never zero-fill.

The accessor is read DIRECTLY off the lake contract: ``pit_metric_history`` (imported from
``quant_core.fundamentals.lake.contract``, NOT through ``fundamentals/__init__`` — that package's
top-level pyarrow import is avoided per the Task-1 / card #224 note). The contract already applies the
PIT look-ahead guard (``knowledge_ts <= as_of_ms``) and bounds the tail by ``years``, so this layer is
PIT-correct and OOM-safe by construction — it adds no unbounded read.
"""
from __future__ import annotations

from typing import Optional

from quant_core.fundamentals.lake.contract import pit_metric_history
from quant_core.ticker_identity import TickerIdentity

# The standard annual-EPS forecast horizons (years ahead). The no-drift RW forecast is identical at
# every horizon — kept as a tuple so a caller asking "give me t+1/t+2/t+3" gets the same value at each
# and the ensemble can align members by horizon key.
HORIZONS: tuple[int, ...] = (1, 2, 3)

# The metric/freq keys this baseline reads off the lake contract (the `METRICS` vocabulary).
_EARNINGS_METRIC = "net_income"
_SHARES_METRIC = "shares_outstanding"
_ANNUAL_FREQ = "a"

# Minimum annual earnings points to forecast at all. One knowable annual EPS is enough for a no-drift
# random walk (the forecast IS that last value) — fewer means there is no base year to walk forward, so
# we omit the name. (A richer ensemble member that needs a trend would raise this floor; the no-drift
# RW deliberately does not.)
_MIN_ANNUAL_POINTS = 1


def _split_adjusted_eps(store, ident: TickerIdentity, as_of_ms: int) -> Optional[list[float]]:
    """The as-of annual EPS series (oldest-first), put on a single SPLIT-ADJUSTED share basis.

    EPS is not a raw lake fact here; it is ``net_income[fy] ÷ shares``. The split-adjustment is the
    choice of share count: every fiscal year's net income is divided by the SAME share count — the
    latest one knowable as-of — rather than each year's own as-reported count. That single current
    basis is exactly what makes the series split-adjusted: a 2:1 split between FY ``t`` and FY ``t+1``
    doubles the raw share count, which would halve the nominal per-share figure and break continuity;
    dividing both years by the current (post-split) count expresses both on today's shares, so the EPS
    series moves only with earnings, not with the split. (This mirrors the platform's PIT market-cap
    identity, which likewise reads the single ``shares_outstanding(as_of)`` cover-page count.)

    Fail-closed throughout — returns ``None`` (the whole series is unusable) when:
      * the name is non-US / unresolved / cold → ``pit_metric_history`` yields ``[]``;
      * there is no knowable annual ``net_income`` point as-of;
      * there is no usable share count (no instant point, or a ``shares <= 0`` — a fabricated/zero
        denominator must never produce a number, the same axis as ``quality.py``'s denominators).
    """
    earnings = pit_metric_history(store, ident, _EARNINGS_METRIC, _ANNUAL_FREQ, as_of_ms)
    if len(earnings) < _MIN_ANNUAL_POINTS:
        return None  # non-US/cold/young: nothing to walk forward (fail-closed, never zero-fill)

    # `shares_outstanding` is an INSTANT metric (`metric_series` ignores `freq` for instants — the
    # contract resolves the cover-page count series). The latest as-of point is the current count; it
    # is the single split-adjusted basis applied to EVERY year.
    shares_points = pit_metric_history(store, ident, _SHARES_METRIC, _ANNUAL_FREQ, as_of_ms)
    if not shares_points:
        return None  # no knowable share count → EPS undefined (fail-closed)
    shares_as_of = shares_points[-1]["value"]  # latest-known instant (points are oldest-first)
    if shares_as_of <= 0:
        return None  # a zero/negative denominator is never a real per-share figure

    return [p["value"] / shares_as_of for p in earnings]


def seasonal_random_walk_eps(
    store, ident: TickerIdentity, as_of_ms: int
) -> Optional[float]:
    """The no-drift seasonal random-walk forecast of next annual EPS — the latest as-of annual EPS.

    The baseline's single scalar: under a no-drift random walk the best forecast of EPS at every future
    annual horizon IS the most recent knowable annual EPS (no trend term — Bradshaw et al. 2012, annual
    EPS). ``seasonal_random_walk_eps_path`` wraps this to emit it at each of ``HORIZONS``.

    Returns ``None`` (fail-closed, OMITTED — never 0) when:
      * the name is non-US / unresolved / cold, or history is too thin (no knowable annual EPS point);
      * the base year (the latest annual EPS) is ``<= 0`` — a random walk off a LOSS is not a
        meaningful earnings forecast (growth would be undefined), so the base year is excluded.
    """
    eps = _split_adjusted_eps(store, ident, as_of_ms)
    if eps is None:  # non-US / cold / thin / no shares
        return None
    base = eps[-1]  # the latest annual EPS (the series is oldest-first) — the base year
    if base <= 0:
        return None  # exclude a negative/zero base-year (no RW off a loss)
    return base  # no drift: the forecast is the base year itself, at every horizon


def seasonal_random_walk_eps_path(
    store, ident: TickerIdentity, as_of_ms: int, horizons: tuple[int, ...] = HORIZONS
) -> Optional[dict[int, float]]:
    """The no-drift RW forecast keyed by horizon — ``{τ: EPS_forecast}`` for each ``τ`` in ``horizons``.

    No drift means the value is identical at every horizon (the ensemble aligns members on the horizon
    key, so the baseline must present one per τ). ``None`` propagates the fail-closed cases of
    ``seasonal_random_walk_eps`` (non-US / thin / negative base-year) — the whole path is omitted, never
    a dict of zeros.
    """
    forecast = seasonal_random_walk_eps(store, ident, as_of_ms)
    if forecast is None:
        return None
    return {tau: forecast for tau in horizons}
