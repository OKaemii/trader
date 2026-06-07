"""Pure effective-dated interval resolution — the testable core of `resolve_symbol`.

The as-of question ("which interval of this identifier contains `as_of`?") is answered HERE, in
plain Python over already-fetched rows, rather than inside a SQL window function — so the resolution
rule (read-time closure + half-open containment) is exhaustively unit-testable WITHOUT a live
Postgres, which is what the canonical FB→META test needs. `resolver.py` does only the thin SELECT of
candidate rows and delegates the decision to `resolve_interval` below.

THE RULE (one place, so the writer's append-only history and the reader agree):
  * Each identifier value owns the half-open interval `[effective_from, effective_to_eff)`.
  * `effective_to_eff` = the stored `effective_to` when present (an explicit close — e.g. a
    delisting gap, or a rename whose date was known at insert), ELSE the `effective_from` of the
    NEXT interval for the SAME (instrument, identifier_type) in `effective_from` order (read-time
    closure of an append-only row that was left open), ELSE open-ended (+∞).
  * A row is valid at `as_of` iff `effective_from <= as_of < effective_to_eff`. The boundary instant
    belongs to the NEW value (at the exact rename ms the new ticker is already in force).
  * If several rows somehow contain `as_of` (overlapping history), the one with the greatest
    `effective_from` wins (the most recent assertion).

This closes the FB→META case: with FB `[t_fb, NULL]` then META `[t_meta, NULL]` for one instrument,
FB's effective end becomes `t_meta` (the successor's start), so `as_of < t_meta` resolves FB and
`as_of >= t_meta` resolves META — even though neither row stored an explicit `effective_to`.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class IdentifierInterval:
    """One effective-dated identifier row as fetched from `security_master.identifiers`, carrying the
    owning instrument's join columns so the resolved interval needs no second round-trip."""

    instrument_id: int
    identifier_type: str
    identifier_value: str
    effective_from: int
    effective_to: Optional[int]
    # Instrument/company join columns (NULL company cik for non-US names).
    company_id: int
    t212_ticker: Optional[str]
    cik: Optional[str]


def _effective_upper_bounds(rows: list[IdentifierInterval]) -> dict[int, Optional[int]]:
    """Compute each row's effective upper bound (the LEAD-equivalent), keyed by the row's index in
    `rows`. Successor lookup is partitioned by `(instrument_id, identifier_type)` and ordered by
    `effective_from`, matching the SQL window the design references."""
    # Group row indices by partition, sorted by effective_from (then by a stable tiebreak so equal
    # effective_from values have a deterministic successor order).
    partitions: dict[tuple[int, str], list[int]] = {}
    for idx, r in enumerate(rows):
        partitions.setdefault((r.instrument_id, r.identifier_type), []).append(idx)

    upper: dict[int, Optional[int]] = {}
    for indices in partitions.values():
        ordered = sorted(indices, key=lambda i: (rows[i].effective_from, i))
        for pos, idx in enumerate(ordered):
            row = rows[idx]
            successor_from = (
                rows[ordered[pos + 1]].effective_from if pos + 1 < len(ordered) else None
            )
            # Explicit close wins; else the successor's start; else open-ended (None).
            if row.effective_to is not None:
                upper[idx] = row.effective_to
            elif successor_from is not None:
                upper[idx] = successor_from
            else:
                upper[idx] = None
    return upper


def resolve_interval(
    rows: list[IdentifierInterval], identifier_value: str, as_of_ms: int
) -> Optional[IdentifierInterval]:
    """STRICT effective-dated match: the interval of `identifier_value` whose half-open window
    contains `as_of_ms`, or None when the value itself was not in force at that instant.

    "FB" @ 2019 → the FB interval; "META" @ 2019 → None (the string "META" wasn't the ticker yet).
    This is the literal "what did this ticker string point at on this date?" answer; `resolve_symbol`
    layers the headline "name-it-today, ask-about-its-past" fallback on top (see
    `resolve_instrument_id`).

    `rows` are ALL intervals for the instrument(s) that ever carried `identifier_value` (so the
    successor of the queried value is present for read-time closure); the function filters to the
    queried value for the containment test but uses the full set for the LEAD bound."""
    upper = _effective_upper_bounds(rows)
    best: Optional[int] = None
    for idx, row in enumerate(rows):
        if row.identifier_value != identifier_value:
            continue
        hi = upper[idx]
        # Half-open containment: from <= as_of < to (open-ended hi ⇒ no upper limit).
        if row.effective_from <= as_of_ms and (hi is None or as_of_ms < hi):
            if best is None or row.effective_from > rows[best].effective_from:
                best = idx
    return rows[best] if best is not None else None


def resolve_instrument_id(
    rows: list[IdentifierInterval], identifier_value: str, as_of_ms: int
) -> Optional[int]:
    """The instrument `identifier_value` IDENTIFIES, with the as-of fallback the QA headline needs.

    The plan's headline guarantee is `resolve_symbol("META", "2019-01-01")` → the FB-era INSTRUMENT
    (so its 2019 fundamentals can then be read): the caller names the instrument by the ticker it
    carries TODAY and asks about its past. So:
      1. If `identifier_value`'s own interval contains `as_of` (the strict match), use that interval's
         instrument — `resolve_symbol("FB", 2019)` lands here.
      2. Otherwise the value names an instrument by an identifier that wasn't in force at `as_of`
         (the rename case: "META" asked about 2019). Fall back to the instrument that carries this
         value in its MOST RECENT interval — `resolve_symbol("META", 2019)` lands here and returns the
         same instrument FB resolves to. This is an identity hop (CIK/instrument are rename-invariant),
         not a temporal claim that "META" was the 2019 ticker.

    Both FB and META therefore resolve to the same instrument for a 2019 as-of; the FACTS read at that
    instrument are still gated by `as_of` downstream. Returns None only when the value is unknown
    entirely."""
    strict = resolve_interval(rows, identifier_value, as_of_ms)
    if strict is not None:
        return strict.instrument_id
    # Fallback: the instrument whose latest interval carries this value (present identity → past data).
    latest: Optional[int] = None
    for idx, row in enumerate(rows):
        if row.identifier_value != identifier_value:
            continue
        if latest is None or row.effective_from > rows[latest].effective_from:
            latest = idx
    return rows[latest].instrument_id if latest is not None else None
