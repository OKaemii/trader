"""Stage resolver — metric registry application over raw facts (epic Task 6).

Turns a CIK's RAW us-gaap/dei facts (the `download.edgar.RawFact` parser output, identical in shape to
a `fundamentals_raw_facts` row) into STAGED "interpreted facts" keyed to the canonical
`quant_core.fundamentals.LINE_ITEMS` metric names. This is the US-normalization SELECT step: it does
NOT write, does NOT supersede, does NOT derive availability (`knowledge_ts` stays the raw
`accepted_ts`); the bi-temporal `fundamentals` writer is the NEXT card (Task 7), which consumes these
interpreted facts.

WHAT "interpreting" means here — six rules, all grounded in the raw fact identity
`(cik, raw_tag, unit, period_start, period_end, dim_signature, accession_number)` (research §4):

  1. HIGHEST-PRIORITY PRESENT TAG. For each canonical metric, the registry lists candidate tags in
     preference order; the resolver picks the first tag PRESENT for a (period, dim) — a filer reporting
     `RevenueFromContractWithCustomerExcludingAssessedTax` is read off it; an older filer reporting only
     `Revenues` falls through. (registry.candidates)

  2. INSTANT vs DURATION kept separate. `period_type` ('instant'|'duration') is already on the raw fact
     (a balance-sheet point vs a flow over an interval). A metric is interpreted from its own kind —
     balance-sheet metrics from instants, flow metrics from durations — so an instant and a duration
     sharing a period_end never cross-contaminate.

  3. QTD vs YTD chosen EXPLICITLY for flow metrics. A 10-Q reports BOTH the quarter (~91 days) and the
     YTD cumulative (Q3 → ~273 days) as durations ending the same day. The resolver keeps the period
     whose (start,end) span matches the FISCAL QUARTER (the discrete-quarter flow), not the cumulative —
     so summing/period math downstream never double-counts. FY facts keep their full-year span.

  4. SEGMENT facts isolated. `dim_signature != ''` marks a dimensional/segment framing (a business-unit
     breakout). Those are isolated from the consolidated total (`dim_signature == ''`) so a segment
     revenue never stands in for, or is summed into, the company total. Segment facts are surfaced
     under their own dim_signature, never merged into the consolidated metric.

  5. VALUE-AGREEMENT GUARD. When two DIFFERENT candidate tags for the same metric are both present for
     the same (period, dim) but their VALUES DISAGREE (beyond a relative tolerance), the resolver does
     NOT silently pick one and move on — that is a data-quality conflict, not a clean fallback. It
     yields no consolidated fact for that (metric, period) and records the conflict, so a false merge
     (e.g. `Revenues` = a segment subtotal while the contract-revenue tag = the real total) can't slip
     a wrong number into the warehouse.

  6. CANONICAL KEYS, NEVER RE-LISTED. The metric names come from the registry, which is pinned to
     `quant_core.fundamentals.LINE_ITEMS` at load — staging emits exactly the spellings the factors
     read.

The resolver is a PURE function over a list of `RawFact` + a CIK + a sector template (+ a registry).
The tests build the raw facts with Task 5's `parse_company_facts` over recorded JSON — no network, no
DB. The CIK and sector are parameters (a companyfacts payload is per-CIK; the SIC→template map is the
normalizer's, Task 7 — staging is HANDED the chosen template and defaults to 'general').
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from src.download.edgar import RawFact

from .registry import DEFAULT_SECTOR, MetricRegistry, default_registry

# Day in ms — fiscal-period span maths (QTD vs YTD).
_DAY_MS = 86_400_000

# Target span (ms) by fiscal period, used to pick the QTD frame over the YTD cumulative. A 10-Q's
# discrete quarter is ~91 days; the YTD cumulative at Q2/Q3/Q4 is ~182/273/365. FY is the full year.
# We pick the duration whose span is CLOSEST to its fiscal-period target — the discrete-quarter flow,
# never the cumulative. Approximate by construction (calendars vary); closeness, not equality, decides.
_QUARTER_MS = 91 * _DAY_MS
_TARGET_SPAN_MS: dict[str, int] = {
    "Q1": _QUARTER_MS,
    "Q2": _QUARTER_MS,
    "Q3": _QUARTER_MS,
    "Q4": _QUARTER_MS,
    "FY": 365 * _DAY_MS,
}

# Relative tolerance for the value-agreement guard. Two candidate tags for the same (metric, period,
# dim) "agree" iff |a-b| <= tol * max(|a|,|b|). 0.5% absorbs rounding/units-of-presentation noise (a
# filer tagging the same figure to two synonymous tags) while still catching a genuine disagreement (a
# segment subtotal vs the consolidated total differ by far more than 0.5%).
_VALUE_AGREEMENT_REL_TOL = 0.005


@dataclass(frozen=True)
class FactKey:
    """The raw fact identity the resolver keys on (research §4): everything that distinguishes one
    preserved fact from another. `cik` scopes it to a filer (a companyfacts payload is per-CIK, so the
    parser output carries no cik — it is supplied to the resolver and stamped here)."""

    cik: str
    raw_tag: str
    unit: Optional[str]
    period_start: Optional[int]
    period_end: int
    dim_signature: str
    accession_number: Optional[str]


@dataclass(frozen=True)
class InterpretedFact:
    """One staged interpreted fact: a raw fact selected + relabelled to a canonical metric. NOT yet
    bi-temporal (no supersede, no availability hop) — that is the Task 7 writer's job, which consumes
    these. Carries full provenance back to the chosen raw fact so the writer (and an auditor) can trace
    a canonical value to its `(metric ← raw_tag)` source.

      * `metric` — the canonical `LINE_ITEMS` key.
      * `value`/`unit`/`currency` — straight from the selected raw fact (staging never converts).
      * `period_start`/`period_end`/`period_type` — the observation interval + its kind.
      * `fiscal_year`/`fiscal_period` — SEC's fy/fp, preserved for the writer's fiscal labelling.
      * `dim_signature` — '' for consolidated; a non-empty signature marks a surfaced SEGMENT fact.
      * `is_segment` — convenience flag (`dim_signature != ''`) so the writer/consumer can route
        consolidated vs segment without re-deriving.
      * `raw_tag`/`accession_number` — provenance: which tag was chosen, from which filing.
      * `knowledge_ts` — carried THROUGH unchanged (the raw `accepted_ts`); the next-session
        availability derivation is Task 7, not here.
    """

    metric: str
    cik: str
    value: Optional[float]
    unit: Optional[str]
    currency: Optional[str]
    period_start: Optional[int]
    period_end: int
    period_type: str
    fiscal_year: Optional[int]
    fiscal_period: Optional[str]
    dim_signature: str
    is_segment: bool
    raw_tag: str
    accession_number: Optional[str]
    knowledge_ts: Optional[int] = None


@dataclass(frozen=True)
class ValueConflict:
    """A value-agreement guard rejection: two candidate tags for the same (metric, period, dim) were
    both present with disagreeing values, so NO consolidated fact was emitted for that (metric, period).
    Surfaced (returned alongside the facts) rather than swallowed — it is a data-quality signal the QA
    step (Task 8) and an operator want to see, not a silent drop."""

    metric: str
    cik: str
    period_start: Optional[int]
    period_end: int
    dim_signature: str
    tag_a: str
    value_a: Optional[float]
    tag_b: str
    value_b: Optional[float]


@dataclass(frozen=True)
class StageResult:
    """The resolver's output: the staged interpreted facts (consolidated + isolated segment facts) plus
    any value-agreement conflicts that suppressed a consolidated emission."""

    facts: tuple[InterpretedFact, ...]
    conflicts: tuple[ValueConflict, ...]


def fact_key(fact: RawFact, *, cik: str) -> FactKey:
    """The `(cik, raw_tag, unit, period_start, period_end, dim_signature, accession_number)` identity
    for a raw fact under a CIK."""
    return FactKey(
        cik=str(cik),
        raw_tag=fact.raw_tag,
        unit=fact.unit,
        period_start=fact.period_start,
        period_end=fact.period_end,
        dim_signature=fact.dim_signature or "",
        accession_number=fact.accession_number,
    )


def _values_agree(a: Optional[float], b: Optional[float]) -> bool:
    """True iff two values agree within the relative tolerance. Two Nones agree (nothing to disagree
    about); a None vs a number disagrees (one tag reported, the other didn't — not a clean match)."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    scale = max(abs(a), abs(b))
    if scale == 0.0:
        return a == b
    return abs(a - b) <= _VALUE_AGREEMENT_REL_TOL * scale


def _span(fact: RawFact) -> Optional[int]:
    """A duration fact's span in ms (end - start), or None for an instant / missing start."""
    if fact.period_start is None:
        return None
    return fact.period_end - fact.period_start


def _select_flow_frame(facts: list[RawFact]) -> RawFact:
    """From duration facts that share a (metric, period_end, dim, tag), pick the one whose span matches
    its fiscal-period intent — the QTD discrete quarter, not the YTD cumulative.

    Picks the fact minimising |span - target(fiscal_period)|. When fiscal_period is unknown/missing for
    all, falls back to the SHORTEST span (the discrete-quarter flow is always ≤ the cumulative, so
    shortest is the safe non-cumulative choice). Deterministic tie-break on (span, period_start)."""
    def sort_key(f: RawFact) -> tuple:
        span = _span(f)
        # Instants shouldn't reach here, but guard: treat a missing span as +inf distance so a real
        # duration always wins.
        if span is None:
            return (1, float("inf"), float("inf"), 0)
        target = _TARGET_SPAN_MS.get((f.fiscal_period or "").upper())
        if target is None:
            # No fiscal-period target → prefer the shortest span (non-cumulative).
            return (0, 0, span, f.period_start or 0)
        return (0, 1, abs(span - target), f.period_start or 0)

    return sorted(facts, key=sort_key)[0]


def _present_candidate_facts(
    raw_by_tag: dict[str, list[RawFact]],
    candidates: tuple[str, ...],
) -> list[tuple[str, RawFact]]:
    """For one (metric, period_end, dim) bucket: walk the registry candidate tags in preference order
    and collect `(tag, fact)` for every candidate tag that is PRESENT, keeping only one fact per tag
    (the flow-frame–selected one if several share the slot). Order preserved = preference order, so the
    first entry is the highest-priority present tag."""
    out: list[tuple[str, RawFact]] = []
    for tag in candidates:
        facts = raw_by_tag.get(tag)
        if not facts:
            continue
        out.append((tag, facts[0]))
    return out


def resolve_metrics(
    raw_facts: Iterable[RawFact],
    *,
    cik: str,
    sector: str = DEFAULT_SECTOR,
    registry: Optional[MetricRegistry] = None,
) -> StageResult:
    """Stage a CIK's raw facts into interpreted facts keyed to canonical metrics.

    `sector` selects the per-sector candidate overrides (default 'general'); `registry` defaults to the
    packaged one. The output is order-independent of the input. See the module docstring for the six
    interpretation rules. The function is pure — no I/O, no DB — so it tests against fixture-built raw
    facts directly.
    """
    reg = registry or default_registry()
    facts_list = list(raw_facts)

    out_facts: list[InterpretedFact] = []
    conflicts: list[ValueConflict] = []

    for metric in reg.metrics():
        candidates = reg.candidates(metric, sector)
        if not candidates:
            # Sector override is an empty list ("no tag for this sector") → emit nothing for it.
            continue
        is_flow = reg.is_flow_metric(metric)
        candidate_set = set(candidates)

        # Bucket this metric's candidate facts by (period_end, dim_signature). Instant vs duration is
        # implied by `is_flow` (we only consider facts of the matching kind per metric), so an instant
        # and a duration sharing a period_end never land in the same bucket / cross-contaminate.
        # Bucket value: {tag: [RawFact, …]} (a tag can have several facts in a flow slot — QTD+YTD).
        buckets: dict[tuple[int, str], dict[str, list[RawFact]]] = {}
        for fact in facts_list:
            if fact.raw_tag not in candidate_set:
                continue
            # Rule 2: a flow metric is interpreted from durations; an instant metric from instants.
            if is_flow and fact.period_type != "duration":
                continue
            if not is_flow and fact.period_type != "instant":
                continue
            dim = fact.dim_signature or ""
            slot = buckets.setdefault((fact.period_end, dim), {})
            slot.setdefault(fact.raw_tag, []).append(fact)

        for (period_end, dim), raw_by_tag in buckets.items():
            # Rule 3 (flows): collapse each tag's QTD+YTD candidates to the fiscal-quarter frame.
            if is_flow:
                raw_by_tag = {tag: [_select_flow_frame(fs)] for tag, fs in raw_by_tag.items()}
            else:
                # Instants: at most one fact per tag per (period_end, dim) normally; if a source ever
                # gives duplicates, take the first deterministically (sorted by accession) — values are
                # identical for a true instant, and the value-agreement guard catches a real conflict.
                raw_by_tag = {
                    tag: [sorted(fs, key=lambda f: (f.accession_number or ""))[0]]
                    for tag, fs in raw_by_tag.items()
                }

            present = _present_candidate_facts(raw_by_tag, candidates)
            if not present:
                continue

            is_segment = dim != ""
            chosen_tag, chosen = present[0]  # rule 1: highest-priority present tag

            # Rule 5: value-agreement guard. Compare the chosen tag against every OTHER present
            # candidate tag for this same (period, dim). A disagreement suppresses the CONSOLIDATED
            # emission (a segment bucket is already isolated, so the guard there only protects against a
            # mis-tagged duplicate within the same segment). Surface the first conflicting pair.
            #
            # The comparison is FRAME-MATCHED: only other-tag facts sharing the chosen fact's
            # `period_start` are compared, so two tags whose flow-frame selection landed on DIFFERENT
            # periods (e.g. tag A reported the QTD while tag B only reported the YTD cumulative for the
            # same period_end) are NOT cross-checked — a 90-day value vs a 273-day value is a different
            # period, not a disagreement, and must not falsely suppress a valid fact. (Instants all
            # share period_start=None, so this is a no-op for balance-sheet metrics.)
            conflict: Optional[ValueConflict] = None
            for other_tag, other in present[1:]:
                if other.period_start != chosen.period_start:
                    continue  # different period (QTD vs YTD frame) — not comparable, not a conflict
                if not _values_agree(chosen.value, other.value):
                    conflict = ValueConflict(
                        metric=metric, cik=str(cik),
                        period_start=chosen.period_start, period_end=period_end, dim_signature=dim,
                        tag_a=chosen_tag, value_a=chosen.value,
                        tag_b=other_tag, value_b=other.value,
                    )
                    break
            if conflict is not None:
                conflicts.append(conflict)
                continue  # do NOT emit a fact whose candidate tags disagree

            out_facts.append(
                InterpretedFact(
                    metric=metric,
                    cik=str(cik),
                    value=chosen.value,
                    unit=chosen.unit,
                    currency=chosen.currency,
                    period_start=chosen.period_start,
                    period_end=period_end,
                    period_type=chosen.period_type,
                    fiscal_year=chosen.fiscal_year,
                    fiscal_period=chosen.fiscal_period,
                    dim_signature=dim,
                    is_segment=is_segment,
                    raw_tag=chosen_tag,
                    accession_number=chosen.accession_number,
                    knowledge_ts=None,  # raw accepted_ts is stamped by the writer (Task 7), not here
                )
            )

    # Stable, deterministic ordering for the consumer + the tests: by metric, then period_end, then
    # consolidated-before-segment, then dim_signature.
    out_facts.sort(key=lambda f: (f.metric, f.period_end, f.is_segment, f.dim_signature))
    conflicts.sort(key=lambda c: (c.metric, c.period_end, c.dim_signature))
    return StageResult(facts=tuple(out_facts), conflicts=tuple(conflicts))
