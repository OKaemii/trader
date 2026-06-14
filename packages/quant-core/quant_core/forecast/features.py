"""Per-firm-year regression inputs for the analyst-free cross-sectional forecasts.

The cross-sectional members (Li-Mohanram **RI** / **EP** and **HVZ**, ``cross_sectional.py``) and the
ensemble's growth-shrinkage step train on a pooled panel of firm-fiscal-year rows. This module builds
one such row from the point-in-time lake series — the foundation the pooled OLS pools.

THE INPUTS (per firm-fiscal-year), straight from the cited methods brief:

  * ``E``  = net income (``us-gaap:NetIncomeLoss`` → ``ifrs-full:ProfitLoss``; the ``net_income`` leg).
  * ``A``  = total assets (the ``total_assets`` instant leg) — the **deflator**.
  * ``B``  = total equity / book value (the ``total_equity`` instant leg).
  * ``D``  = dividends paid. Preferred from a lake dividend series when present, else an **injected**
    EODHD ``Σ DPS × shares`` callable (the lake does not yet carry a dividends-paid fact, so the
    market-layer dividend feed fills it — injected, never fetched here, so this module stays pure).
  * ``DD`` = ``1`` if ``D > 0`` else ``0`` — the dividend-payer dummy (HVZ).
  * ``NegE`` = ``1`` if ``E < 0`` else ``0`` — the loss dummy (HVZ + Li-Mohanram).
  * ``AC`` = ``E − CFO`` — accruals, **bare Hribar-Collins** (2002): income before extraordinary items
    minus operating cash flow, off the cash-flow statement (robust to the M&A / divestiture / FX
    "non-articulation" bias that breaks Sloan's balance-sheet accruals). The discontinued-ops cash
    line (XIDOC) is routinely un-tagged in XBRL, so the *bare* ``IB − CFO`` is used, not the
    XIDOC-adjusted form. **``AC = 0`` for financials** (bank / insurance): the accrual construct is
    economically meaningless for them and the lake fails their cash-flow legs closed anyway.

SCALE-BY-TOTAL-ASSETS — the currency-free pool. Every flow / level is divided by ``A`` so the panel is
a set of dimensionless ratios that pool across currencies (the forward-proofing for the card-131
multi-region pool): ``roa = E/A``, ``payout = D/A``, ``accruals_to_assets = AC/A``, ``book_to_assets =
B/A``. (Li-Mohanram's *primary* deflator is per-share; per-total-assets is an accepted
inference-preserving robustness deflator — HVZ p.507, LM §6 — and the right poolability call for a
multi-currency pool.) ``A`` itself is kept (the prediction step multiplies a fitted ratio back by the
current ``A`` to recover an earnings level).

SANITY FILTERS — applied **BEFORE any winsorization** (winsorization is the cross-sectional layer's
job, Task 4: 1/99 within each as-of cross-section with stored thresholds; it must see clean rows). A
firm-year is dropped (returns ``None`` — listwise, never zero-filled) when:

  * ``A`` is missing or below ``MIN_ASSETS_FLOOR`` — a near-zero denominator makes every ratio explode
    (a shell / pre-revenue micro-entity), so it is excluded before it can distort the cross-section.
  * ``E`` (net income) is missing — there is no label and no ``E/A``; the row is unusable.
  * ``|E/A| > ROA_SANITY_BOUND`` — an ROA magnitude past this is an accounting artefact (a one-off gain
    on a tiny asset base, a mis-tagged restructuring), not a forecastable earnings level.

FAIL-CLOSED, EVERYWHERE — mirrors ``quant_core.screen.quality``: a leg that did not resolve is OMITTED
from the feature row (``B`` / ``D`` / ``CFO`` absent ⇒ ``book_to_assets`` / ``payout`` / accruals
simply not set), **never coerced to 0** (a fabricated 0 would corrupt a ratio and the regression). The
two legs the row CANNOT exist without are ``E`` and ``A`` (the deflator + the thing being forecast);
their absence drops the whole row. ``DD`` / ``NegE`` are only defined when their underlying leg
(``D`` / ``E``) resolved.

PURE — no I/O, no network, no pyarrow. The caller (fundamentals-api estimates assembly / backtest
replay) fetches each metric's PIT series via ``pit_metric_history`` and the dividend feed, then hands
the aligned values in. This module only does the arithmetic + the fail-closed filtering, so the unit
tests run with plain dicts (no synthetic lake).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Callable, Optional

# A firm-year whose total assets fall below this are excluded: a near-zero deflator makes ``E/A`` and
# every other scaled input explode, so a shell / pre-revenue micro-cap would dominate the cross-section
# with meaningless ratios. £/$ ~1e6 (one million, in the lake's USD reporting unit) is comfortably
# below any real operating company yet above the rounding / shell range — a conservative floor that
# excludes the degenerate denominators the brief warns about without clipping a genuine small-cap.
MIN_ASSETS_FLOOR: float = 1_000_000.0

# An |ROA| past this is treated as an accounting artefact (a one-off gain on a tiny asset base, a
# mis-tagged item), not a forecastable earnings level — the row is dropped BEFORE winsorization so it
# cannot drag the within-cross-section caps. 1.5 = 150% return on assets; no real recurring earnings
# stream sits here, and the cross-sectional layer winsorizes the legitimate tail below it.
ROA_SANITY_BOUND: float = 1.5

# An injected resolver for a fiscal year's dividends paid, keyed by the annual period-end ``date`` —
# the EODHD ``Σ DPS × shares`` for that fiscal year. Returns ``None`` when the feed has no figure for
# that year (⇒ the row's ``payout`` / ``DD`` are simply not set — fail-closed, NOT a zero-dividend
# claim; "no data" and "paid nothing" are different and only a populated lake/feed value distinguishes
# them). Pure from this module's perspective — the I/O lives in the caller.
DividendResolver = Callable[[date], Optional[float]]


@dataclass(frozen=True)
class FirmYearFeatures:
    """One firm-fiscal-year row of scaled regression inputs (the panel the pooled OLS trains on).

    ``period_end`` is the annual fiscal year-end ``date`` (the row's identity in the panel + the axis
    the vintage join ages on at Task 4). ``knowledge_ts`` is the UTC-ms instant the row became knowable
    (the earnings leg's ``knowledge_ts``) — carried so the cross-sectional layer can age BOTH the
    feature and the realised label on it (no look-ahead).

    The raw levels (``net_income`` / ``total_assets`` / ``total_equity`` / ``dividends`` / ``accruals``)
    are kept alongside the scaled ratios: ``total_assets`` because prediction multiplies a fitted ratio
    back by the current ``A`` to recover an earnings level, the others for diagnostics / the ensemble's
    sustainable-growth leg.

    FAIL-CLOSED shape: only ``net_income`` / ``total_assets`` / ``roa`` are guaranteed (the row would
    not exist otherwise). ``total_equity`` / ``book_to_assets``, ``dividends`` / ``payout`` / ``dd``,
    and ``accruals`` / ``accruals_to_assets`` are ``Optional`` — ``None`` exactly when their underlying
    leg did not resolve (never a fabricated 0). ``neg_e`` is always set (``E`` is mandatory).
    """

    period_end: date
    knowledge_ts: Optional[int]

    # Mandatory legs — the row cannot exist without them (the sanity filter enforces it).
    net_income: float            # E
    total_assets: float          # A (the deflator; kept for the predict-time ratio × A step)
    roa: float                   # E / A
    neg_e: int                   # 1 if E < 0 else 0  (loss dummy)

    # Fail-closed optional legs — present iff the underlying leg resolved (None, never 0, otherwise).
    total_equity: Optional[float] = None          # B
    book_to_assets: Optional[float] = None        # B / A
    dividends: Optional[float] = None             # D
    payout: Optional[float] = None                # D / A
    dd: Optional[int] = None                      # 1 if D > 0 else 0  (dividend-payer dummy)
    accruals: Optional[float] = None              # AC = E - CFO  (0 for financials)
    accruals_to_assets: Optional[float] = None    # AC / A


def build_firm_year_features(
    *,
    period_end: date,
    net_income: Optional[float],
    total_assets: Optional[float],
    total_equity: Optional[float] = None,
    cash_flow_ops: Optional[float] = None,
    dividends: Optional[float] = None,
    dividend_resolver: Optional[DividendResolver] = None,
    is_financial: bool = False,
    knowledge_ts: Optional[int] = None,
) -> Optional[FirmYearFeatures]:
    """Build one scaled firm-year feature row, or ``None`` if the sanity filters drop it.

    The legs are the aligned values for ONE fiscal year (the caller pairs them by annual period-end
    from the per-metric ``pit_metric_history`` series): ``net_income`` (E), ``total_assets`` (A),
    ``total_equity`` (B), ``cash_flow_ops`` (CFO, ⇒ accruals ``E − CFO``). ``dividends`` (D) is the
    lake dividend value when the lake carries one; when it is ``None`` the ``dividend_resolver`` (the
    injected EODHD ``Σ DPS × shares`` callable) is consulted for ``period_end`` as the fallback — the
    "lake dividends if present, else injected EODHD" rule. ``is_financial`` forces ``AC = 0`` (banks /
    insurers). ``knowledge_ts`` is the earnings leg's knowability instant, carried onto the row.

    Sanity filters (applied BEFORE any winsorization — see the module docstring): drop the row when
    ``A`` is missing / below :data:`MIN_ASSETS_FLOOR`, when ``E`` is missing, or when ``|E/A|`` exceeds
    :data:`ROA_SANITY_BOUND`. A dropped row returns ``None`` (listwise exclusion, never zero-filled).

    Fail-closed: a missing optional leg (``B`` / ``D`` / ``CFO``) is OMITTED from the row (the
    corresponding scaled field stays ``None``), never coerced to 0.
    """
    # --- Mandatory-leg sanity gate (BEFORE any ratio is formed, BEFORE any winsorization) ----------
    # E and A are the only legs the row cannot exist without: A is the deflator every scaled input
    # divides by, E is both a feature and the forecast label. A missing/sub-floor A or a missing E ⇒
    # the row is unusable → dropped listwise (None), never zero-filled (a 0 A would divide-by-zero; a
    # 0 E would fabricate a flat-earnings observation that never occurred).
    if total_assets is None or total_assets < MIN_ASSETS_FLOOR:
        return None
    if net_income is None:
        return None

    roa = net_income / total_assets
    # |ROA| sanity bound: an earnings-to-assets magnitude past 150% is an accounting artefact, not a
    # forecastable earnings level — excluded here so it cannot distort the within-cross-section winsor
    # caps the cross-sectional layer computes next (Task 4).
    if abs(roa) > ROA_SANITY_BOUND:
        return None

    neg_e = 1 if net_income < 0 else 0

    # --- Fail-closed optional legs (omit, never 0) --------------------------------------------------
    # Book value B → B/A. Absent ⇒ both stay None (a 0 book would fabricate a zero-equity firm and a
    # 0 book-to-assets, corrupting the RI regression's χ4·(B/A) term).
    book_to_assets: Optional[float] = None
    if total_equity is not None:
        book_to_assets = total_equity / total_assets

    # Dividends D: lake value when present, else the injected EODHD resolver for this fiscal year.
    # A resolver that returns None (no figure for the year) leaves D unset — fail-closed: "no dividend
    # data" is NOT "paid zero" (only a populated value asserts a payout), so DD/payout stay None rather
    # than fabricate a non-payer.
    resolved_dividends: Optional[float] = dividends
    if resolved_dividends is None and dividend_resolver is not None:
        resolved_dividends = dividend_resolver(period_end)

    payout: Optional[float] = None
    dd: Optional[int] = None
    if resolved_dividends is not None:
        payout = resolved_dividends / total_assets
        # The dividend-payer dummy is defined off the resolved figure: a real 0 (a known non-payer
        # with a populated feed) is DD=0; an unresolved D (None) leaves DD unset (handled above).
        dd = 1 if resolved_dividends > 0 else 0

    # Accruals AC = E − CFO (bare Hribar-Collins). AC = 0 for financials (the construct is meaningless
    # for them, and the lake fails their cash-flow legs closed anyway). For a non-financial, AC needs
    # CFO; absent ⇒ accruals stay None (fail-closed — a 0 accrual would fabricate a perfect-articulation
    # firm-year that the χ5·(AC/A) / α5·(AC/A) terms would mis-read).
    accruals: Optional[float] = None
    accruals_to_assets: Optional[float] = None
    if is_financial:
        accruals = 0.0
        accruals_to_assets = 0.0
    elif cash_flow_ops is not None:
        accruals = net_income - cash_flow_ops
        accruals_to_assets = accruals / total_assets

    return FirmYearFeatures(
        period_end=period_end,
        knowledge_ts=knowledge_ts,
        net_income=net_income,
        total_assets=total_assets,
        roa=roa,
        neg_e=neg_e,
        total_equity=total_equity,
        book_to_assets=book_to_assets,
        dividends=resolved_dividends,
        payout=payout,
        dd=dd,
        accruals=accruals,
        accruals_to_assets=accruals_to_assets,
    )
