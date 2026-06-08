"""Pure QA checks over normalized fundamentals (epic Task 8).

This is the side-effect-free check LAYER: it takes ONE filing's facts (the `StageResult.facts` the
Task-7 writer persists, or any iterable of `InterpretedFact`s) + the filer's sector template, and
returns a tuple of `QuarantineFinding`s describing what failed. It NEVER writes — the engine
(`qa/engine.py`) routes the findings to `fundamentals_quarantine`, and it NEVER blocks: a finding is a
data-quality signal raised ALONGSIDE the canonical write (which the Task-7 writer already did for the
good rows), not a reason to drop them. Quarantine is an append review queue (0009), not a gate.

Three families of check, all keyed on the canonical `quant_core.fundamentals.LINE_ITEMS` metric names
(imported, never re-listed — the writer/reader/QA cannot drift to a different spelling):

  1. SECTOR-AWARE BALANCE-SHEET IDENTITY. `total_assets ≈ total_liabilities + total_equity` within a
     relative tolerance — but ONLY for the GENERAL template. A bank / insurer / REIT / utility runs an
     unclassified or sector-specific balance sheet whose us-gaap `Liabilities` tag is often absent or
     not the additive complement of `Assets` (the registry's per-sector overrides leave those legs
     empty for banks/insurers → the metric is NaN-excluded, never fabricated), so applying the General
     identity to a financial would FALSELY quarantine a perfectly good filing. The Edge-Cases section of
     the plan names financials as the quarantine hotspot precisely because of this: the fix is to gate
     the identity on the selected sector template, not to relax the tolerance. Non-general templates
     SKIP the additive identity entirely (no sector-specific identity is asserted here — banks have one,
     but reconstructing it needs line items the registry deliberately doesn't normalize; skipping is the
     honest, false-positive-free choice).

  2. OUTLIER DETECTION (period-over-period). A metric that jumps implausibly versus the SAME
     instrument's prior accepted period for that metric — e.g. Revenue +5000%, Assets −99% — is almost
     always a units-of-presentation slip (thousands vs units), a tagging error, or a restatement
     artefact, not a real value. The check needs the prior period's value, which the engine supplies
     from the warehouse (the latest current row for the logical fact at an EARLIER observation_ts); the
     PURE check just compares a (current, prior) pair against up/down ratio thresholds. A sign flip
     (positive→negative or vice-versa) on a balance-sheet stock that is normally one sign (assets,
     equity, shares) is also flagged.

  3. MISSING-DATA. A filing that resolved NONE of a required core line item (no shares_outstanding, no
     total_revenue, no filings-level coverage) can't feed the QMJ screen / factors honestly. The check
     reports each missing required metric so the name degrades to `{}` downstream (Yahoo fallback live;
     `{}` in replay — never a fabricated value) AND an operator sees WHY on the quarantine surface.

Everything here is a PURE function of its inputs (facts + sector + prior values) — no DB, no network,
no clock — so it unit-tests against fixture-built `InterpretedFact`s directly, exactly like the stage
resolver and the writer's row builder.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping, Optional

from quant_core.fundamentals import LINE_ITEMS

from src.normalize.sectors import TEMPLATE_GENERAL
from src.stage.resolver import InterpretedFact

# ── Quarantine reason vocabulary (0009 column comment: 'identity_break'|'outlier'|'missing_data'|…) ──
# The Task-7 writer already owns 'value_disagreement' (staging value-agreement conflicts); the QA
# engine adds these three. Kept as module constants so the engine, the report aggregation, and the
# tests share one spelling rather than re-typing string literals.
REASON_IDENTITY_BREAK = "identity_break"
REASON_OUTLIER = "outlier"
REASON_MISSING_DATA = "missing_data"

QA_REASONS: tuple[str, ...] = (REASON_IDENTITY_BREAK, REASON_OUTLIER, REASON_MISSING_DATA)

# ── Thresholds ───────────────────────────────────────────────────────────────────
# Balance-sheet identity tolerance: |A - (L+E)| <= tol * max(|A|, |L+E|). 1% absorbs rounding / minor
# noncontrolling-interest presentation differences (the equity tag may or may not include NCI — the
# registry prefers the parent-only StockholdersEquity but falls back to the incl-NCI tag) while still
# catching a genuine break (a mis-tagged Liabilities, a thousands-vs-units slip on one leg). Looser than
# staging's 0.5% value-agreement guard by design: the identity sums two independently-tagged legs whose
# combined rounding band is wider than a single figure double-tagged.
IDENTITY_REL_TOL = 0.01

# Outlier ratio thresholds (current / prior, on the same metric for the same instrument). A >50x jump
# (+4900%) or a collapse to <1% of the prior (−99%) is the band the plan names (Revenue +5000%, Assets
# −99%). Thresholds are deliberately WIDE — real fundamentals are volatile (a small-cap revenue can
# legitimately 5x, an asset sale can halve the balance sheet) and a false outlier-quarantine drops a
# good fact, so we only flag the implausible tail (a units slip is typically 1000x; a sign of a real
# restatement that flipped a value's order of magnitude). Compared on |value| so the magnitude jump is
# separated from a sign flip (handled below).
OUTLIER_UP_RATIO = 50.0     # current >= 50 × prior  → implausible spike
OUTLIER_DOWN_RATIO = 0.01   # current <= 0.01 × prior → implausible collapse

# Metrics whose economic SIGN is effectively fixed — a balance-sheet stock that is (almost) never
# negative. A positive→negative flip here is a strong tagging/units error signal (net_income legitimately
# goes negative — a loss — so it is NOT in this set; equity CAN go negative for a distressed firm but it
# is rare enough to be worth surfacing for review rather than silently trusting).
SIGN_STABLE_METRICS: frozenset[str] = frozenset({
    "total_assets", "total_liabilities", "current_assets", "current_liabilities",
    "total_equity", "total_revenue", "shares_outstanding", "market_cap_gbp",
})

# Required core line items: a filing that resolved NONE of these (per consolidated observation period)
# can't drive the QMJ screen / momentum-quality strategy honestly. shares_outstanding feeds PIT market
# cap; total_revenue + net_income + total_equity are the QMJ/quality minimum. Drawn from LINE_ITEMS so a
# rename of the contract key flows here. NOT every LINE_ITEM is required (gross_profit/current_* are
# legitimately absent for banks) — only the cross-sector core every covered name should report.
REQUIRED_METRICS: tuple[str, ...] = (
    "total_revenue", "net_income", "total_equity", "total_assets", "shares_outstanding",
)

# Defensive: every name we reason about must be a real contract key (a typo here would silently never
# match a fact). Asserted at import so a drift fails the test gate, not production.
_KNOWN = frozenset(LINE_ITEMS)
assert SIGN_STABLE_METRICS <= _KNOWN, "SIGN_STABLE_METRICS drifted from LINE_ITEMS"
assert frozenset(REQUIRED_METRICS) <= _KNOWN, "REQUIRED_METRICS drifted from LINE_ITEMS"


@dataclass(frozen=True)
class QuarantineFinding:
    """One QA failure to route to `fundamentals_quarantine`. PURE data — the engine maps it onto the
    table's `(reason, payload)` columns (instrument_id/filing_id ride in from the engine's call site).

      * `reason`  — one of `QA_REASONS` (the 0009 vocabulary).
      * `metric`  — the canonical line item the check concerns (None for a whole-filing finding).
      * `observation_ts` — the fiscal period the finding concerns (None for a filing-level finding).
      * `detail`  — the JSON-able payload the operator/Task-8 surface reads to see WHY without
        re-running QA (the offending values, the check that fired, the threshold). Always carries a
        stable `"check"` discriminator so the report can group by check.
    """

    reason: str
    metric: Optional[str]
    observation_ts: Optional[int]
    detail: dict


# ── 1. Sector-aware balance-sheet identity ─────────────────────────────────────────
def _consolidated_instant_by_period(
    facts: Iterable[InterpretedFact], metric: str
) -> dict[int, float]:
    """The consolidated (dim_signature == '') instant value of `metric` keyed by observation period_end.
    Segment facts and None values are excluded — the identity is asserted on the consolidated balance
    sheet only, and a missing leg can't enter an additive check."""
    out: dict[int, float] = {}
    for f in facts:
        if f.metric != metric or f.is_segment or f.dim_signature:
            continue
        if f.value is None:
            continue
        out[f.period_end] = float(f.value)
    return out


def check_balance_sheet_identity(
    facts: Iterable[InterpretedFact], *, sector: str
) -> tuple[QuarantineFinding, ...]:
    """`total_assets ≈ total_liabilities + total_equity` per consolidated period — GENERAL template ONLY.

    For a non-general template (bank/insurance/reit/utility) this returns NO findings: those sectors do
    not satisfy the additive General identity (their Liabilities tag is absent or not the additive
    complement of Assets), so asserting it would falsely quarantine a clean financial filing — the exact
    false-positive the plan's "sector identity break" edge case calls out. The identity fires only when
    ALL THREE legs are present for a period (a missing leg is a MISSING-DATA concern, handled separately,
    not an identity break — we don't fabricate the absent leg as 0)."""
    facts = list(facts)
    if sector != TEMPLATE_GENERAL:
        return ()

    assets = _consolidated_instant_by_period(facts, "total_assets")
    liabilities = _consolidated_instant_by_period(facts, "total_liabilities")
    equity = _consolidated_instant_by_period(facts, "total_equity")

    findings: list[QuarantineFinding] = []
    for period_end in sorted(set(assets) & set(liabilities) & set(equity)):
        a = assets[period_end]
        le = liabilities[period_end] + equity[period_end]
        scale = max(abs(a), abs(le))
        # A degenerate all-zero balance sheet trivially "balances"; nothing to flag.
        if scale == 0.0:
            continue
        if abs(a - le) > IDENTITY_REL_TOL * scale:
            findings.append(
                QuarantineFinding(
                    reason=REASON_IDENTITY_BREAK,
                    metric="total_assets",
                    observation_ts=period_end,
                    detail={
                        "check": "balance_sheet_identity",
                        "sector": sector,
                        "total_assets": a,
                        "total_liabilities": liabilities[period_end],
                        "total_equity": equity[period_end],
                        "liabilities_plus_equity": le,
                        "abs_diff": abs(a - le),
                        "rel_diff": abs(a - le) / scale,
                        "rel_tol": IDENTITY_REL_TOL,
                    },
                )
            )
    return tuple(findings)


# ── 2. Outlier detection (period-over-period) ──────────────────────────────────────
def check_outliers(
    facts: Iterable[InterpretedFact], *, prior_values: Mapping[tuple[str, str], float]
) -> tuple[QuarantineFinding, ...]:
    """Flag a consolidated metric that jumps implausibly vs the SAME instrument's prior period.

    `prior_values` maps `(metric, dim_signature)` → the latest known value at an EARLIER observation_ts
    (supplied by the engine from the warehouse; the pure check never reads the DB). A metric with no
    prior entry is skipped (a first-ever observation can't be an outlier). Fires on: a magnitude ratio
    outside `[OUTLIER_DOWN_RATIO, OUTLIER_UP_RATIO]`, OR a sign flip on a `SIGN_STABLE_METRICS` value.
    Only consolidated facts (dim_signature == '') are checked — a segment can legitimately swing."""
    findings: list[QuarantineFinding] = []
    for f in facts:
        if f.is_segment or f.dim_signature or f.value is None:
            continue
        prior = prior_values.get((f.metric, f.dim_signature or ""))
        if prior is None:
            continue
        current = float(f.value)

        # Sign flip on a normally-one-sign stock (treat exact-zero prior/current as no flip — a zero is
        # not a sign, and a divide-by-zero ratio is handled below).
        if f.metric in SIGN_STABLE_METRICS and prior != 0.0 and current != 0.0:
            if (current > 0) != (prior > 0):
                findings.append(
                    QuarantineFinding(
                        reason=REASON_OUTLIER,
                        metric=f.metric,
                        observation_ts=f.period_end,
                        detail={
                            "check": "sign_flip",
                            "metric": f.metric,
                            "current": current,
                            "prior": prior,
                        },
                    )
                )
                continue  # a sign flip is the finding; don't also ratio-flag the same fact

        # Magnitude ratio. A zero prior with a non-zero current is an unbounded jump (0 → something) —
        # flag as a spike; a zero current from a non-zero prior is a collapse.
        if prior == 0.0:
            ratio = float("inf") if current != 0.0 else 1.0
        else:
            ratio = abs(current) / abs(prior)

        if ratio >= OUTLIER_UP_RATIO or ratio <= OUTLIER_DOWN_RATIO:
            findings.append(
                QuarantineFinding(
                    reason=REASON_OUTLIER,
                    metric=f.metric,
                    observation_ts=f.period_end,
                    detail={
                        "check": "period_ratio",
                        "metric": f.metric,
                        "current": current,
                        "prior": prior,
                        "ratio": ratio if ratio != float("inf") else None,
                        "direction": "spike" if ratio >= OUTLIER_UP_RATIO else "collapse",
                        "up_ratio": OUTLIER_UP_RATIO,
                        "down_ratio": OUTLIER_DOWN_RATIO,
                    },
                )
            )
    return tuple(findings)


# ── 3. Missing-data ────────────────────────────────────────────────────────────────
def check_missing_data(
    facts: Iterable[InterpretedFact], *, required: tuple[str, ...] = REQUIRED_METRICS
) -> tuple[QuarantineFinding, ...]:
    """Report each REQUIRED core line item the filing resolved no consolidated value for.

    A required metric counts as PRESENT iff there is at least one consolidated (dim_signature == '')
    fact with a non-None value for it anywhere in the filing's facts (across any period). A wholly
    missing required metric ⇒ one finding (the name degrades to `{}` downstream; the operator sees the
    gap). Segment-only coverage does NOT satisfy a required metric — the factors read consolidated
    totals, not a business-unit breakout."""
    facts = list(facts)
    present: set[str] = set()
    for f in facts:
        if f.is_segment or f.dim_signature or f.value is None:
            continue
        present.add(f.metric)

    findings: list[QuarantineFinding] = []
    for metric in required:
        if metric not in present:
            findings.append(
                QuarantineFinding(
                    reason=REASON_MISSING_DATA,
                    metric=metric,
                    observation_ts=None,
                    detail={
                        "check": "missing_required_metric",
                        "metric": metric,
                        "required": list(required),
                    },
                )
            )
    return tuple(findings)


def run_checks(
    facts: Iterable[InterpretedFact],
    *,
    sector: str,
    prior_values: Optional[Mapping[tuple[str, str], float]] = None,
    required: tuple[str, ...] = REQUIRED_METRICS,
) -> tuple[QuarantineFinding, ...]:
    """Run all three QA check families over one filing's facts and return the combined findings.

    PURE: `sector` gates the identity check (General-only); `prior_values` (default empty) drives the
    outlier check; `required` the missing-data check. The engine calls this, then routes the result to
    quarantine. Order is stable (identity, then outliers, then missing) for deterministic tests."""
    facts = list(facts)
    prior_values = prior_values or {}
    return (
        *check_balance_sheet_identity(facts, sector=sector),
        *check_outliers(facts, prior_values=prior_values),
        *check_missing_data(facts, required=required),
    )
