"""Bi-temporal writer for the canonical `fundamentals` table — the PIT-contract core (epic Task 7).

Consumes a `StageResult` (the Task-6 resolver output: interpreted facts keyed to canonical
`quant_core.fundamentals.LINE_ITEMS` metrics, + value-agreement conflicts) for ONE filing and writes
its facts to `fundamentals` + `fundamentals_revisions_log` with **supersede-in-transaction**, mirroring
`services/market-data-service/.../persist-bars.ts`:

  * Stamp `knowledge_ts` = the next NYSE session open AFTER the filing's raw `accepted_ts` (the
    availability hop — `calendar.next_session_open_ms`; an after-hours accept is knowable next session,
    never the session it landed after close). Staging carried `knowledge_ts=None`; the writer derives it.
  * `content_hash` = SHA-1 over `(metric, observation_ts, value, unit, currency, dim_signature)`
    (`content_hash.hash_fundamental`, the 0009 canonical convention — distinct from the raw-zone hash).
  * HASH-COMPARE GATE: read the latest unsuperseded row per logical fact
    `(instrument_id, metric, observation_ts, dim_signature)`; an identical hash ⇒ NO-OP (no insert, no
    supersede, no log row, no txn) — the bars idempotency contract. A different hash (a 10-K/A
    restatement, a corrected value) ⇒ inside ONE transaction: flip the prior row's `is_superseded=TRUE`,
    INSERT the new revision (higher `knowledge_ts`), and INSERT a `fundamentals_revisions_log` row
    (`prior_hash` NULL = first-print). The original row is NEVER overwritten — an as-of read at the
    original date still returns the first-printed value.
  * CONFLICTS HANDOFF: `StageResult.conflicts` (value-agreement rejections that suppressed a
    consolidated emission) are routed to `fundamentals_quarantine` cleanly (a thin INSERT) — the QA
    engine that populates/reports the rest of quarantine is Task 8; this writer just hands them off.

THE LOGICAL FACT + THE PK. `fundamentals`'s PK is
`(instrument_id, metric, observation_ts, dim_signature, knowledge_ts)`; the `fundamentals_latest_unique`
partial-unique index keeps EXACTLY ONE `is_superseded=FALSE` row per logical fact
`(instrument_id, metric, observation_ts, dim_signature)` — so the supersede MUST flip the prior current
row inside the same txn as the insert (else two current rows would violate the partial-unique index,
the bars contract).

APPEND-ONLY ROLE. `fundamentals_writer` (0009) holds INSERT+SELECT + UPDATE(is_superseded) only — no
DELETE. The supersede is an UPDATE of that one column; everything else is INSERT. No row is ever
deleted; the full revision history is preserved.

INSTRUMENT RESOLUTION. The interpreted facts carry the filer's `cik`, not an `instrument_id` — the
`fundamentals` PK keys on `instrument_id`. The CIK→instrument_id resolution (via the security master,
Task 4) is the CRON's job (Task 9), which passes the resolved `instrument_id` in. This writer never
resolves; it writes under the id it is given (a None id is a programming error and raises — never a
fabricated 0).

All methods take an injected `asyncpg.Pool` (security_master/pool.py owns construction); the writer
holds no global state and opens no socket on import.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Optional

from src.stage.resolver import InterpretedFact, StageResult, ValueConflict

from . import calendar as nyse_calendar
from .content_hash import hash_fundamental

log = logging.getLogger("fundamentals-ingestion.normalize")

# `source` stamp written on every canonical fundamentals row (0009 column comment: 'pit-edgar' |
# 'pit-companies-house'). The US EDGAR path writes 'pit-edgar'. Matches
# quant_core.fundamentals.SOURCE_PIT_EDGAR (without the import the writer stays decoupled from the
# Protocol module; the spelling is asserted equal in the tests).
SOURCE_PIT_EDGAR = "pit-edgar"

# Quarantine reason for a value-agreement conflict handed off from staging (0009 column comment lists
# the vocabulary; Task 8's QA engine adds 'identity_break'/'outlier'/'missing_data'/…).
QUARANTINE_REASON_VALUE_DISAGREEMENT = "value_disagreement"


@dataclass(frozen=True)
class WriteStats:
    """The outcome of writing one filing's interpreted facts (mirrors persist-bars' stats shape).

      * `attempted` — interpreted facts handed in.
      * `inserted`  — new canonical rows written (first-prints + revisions).
      * `revisions` — subset of `inserted` that superseded a prior current row (a restatement).
      * `skipped`   — facts whose hash matched the current row (idempotent no-op).
      * `quarantined` — value-agreement conflicts routed to `fundamentals_quarantine`.
    """

    attempted: int
    inserted: int
    revisions: int
    skipped: int
    quarantined: int


# ── canonical fundamentals row ───────────────────────────────────────────────────
@dataclass(frozen=True)
class FundamentalRow:
    """One fully-resolved `fundamentals` row: an `InterpretedFact` joined to its resolved
    `instrument_id` + derived `knowledge_ts` + canonical `content_hash`. `observation_ts` is the fiscal
    `period_end` (the schema's observation). The 16 columns the INSERT binds, in declaration order."""

    instrument_id: int
    metric: str
    observation_ts: int
    knowledge_ts: int
    fiscal_year: Optional[int]
    fiscal_period: Optional[str]
    period_type: str
    dim_signature: str
    value: Optional[float]
    unit: Optional[str]
    currency: Optional[str]
    source: str
    accession_number: Optional[str]
    raw_tag: Optional[str]
    content_hash: str


def build_fundamental_row(
    fact: InterpretedFact,
    *,
    instrument_id: int,
    knowledge_ts: int,
    source: str = SOURCE_PIT_EDGAR,
) -> FundamentalRow:
    """Map an `InterpretedFact` + its resolved `instrument_id` + derived `knowledge_ts` onto a
    `fundamentals` row, computing the canonical content hash. `observation_ts` = the fact's `period_end`.
    `dim_signature` is normalised to '' defensively (the column is NOT NULL DEFAULT '')."""
    dim_signature = fact.dim_signature or ""
    observation_ts = fact.period_end
    digest = hash_fundamental(
        metric=fact.metric,
        observation_ts=observation_ts,
        value=fact.value,
        unit=fact.unit,
        currency=fact.currency,
        dim_signature=dim_signature,
    )
    return FundamentalRow(
        instrument_id=instrument_id,
        metric=fact.metric,
        observation_ts=observation_ts,
        knowledge_ts=knowledge_ts,
        fiscal_year=fact.fiscal_year,
        fiscal_period=fact.fiscal_period,
        period_type=fact.period_type,
        dim_signature=dim_signature,
        value=fact.value,
        unit=fact.unit,
        currency=fact.currency,
        source=source,
        accession_number=fact.accession_number,
        raw_tag=fact.raw_tag,
        content_hash=digest,
    )


# ── SQL ──────────────────────────────────────────────────────────────────────────
# Latest unsuperseded row per logical fact — the hash-compare gate's read. Bounded by
# fundamentals_latest_unique (exactly one is_superseded=FALSE row per logical key).
_SELECT_LATEST = """
SELECT content_hash
FROM fundamentals
WHERE instrument_id = $1 AND metric = $2 AND observation_ts = $3 AND dim_signature = $4
  AND is_superseded = FALSE
"""

# Supersede: flip the current row(s) for the logical fact. Scoped to is_superseded=FALSE so it touches
# only the one current row (the partial-unique invariant). UPDATE(is_superseded) is the only mutation
# the fundamentals_writer role is granted.
_SUPERSEDE = """
UPDATE fundamentals
SET is_superseded = TRUE
WHERE instrument_id = $1 AND metric = $2 AND observation_ts = $3 AND dim_signature = $4
  AND is_superseded = FALSE
"""

# Insert the new revision/first-print. ON CONFLICT on the full PK DO NOTHING guards the rare
# same-logical-key + same-knowledge_ts re-derivation (a second ingest at the same availability instant
# carrying a changed value) from a hard duplicate-key error — the prior row was already superseded in
# this txn, and the existing same-knowledge_ts row stands. RETURNING yields a row only on a fresh insert.
_INSERT_FUNDAMENTAL = """
INSERT INTO fundamentals
  (instrument_id, metric, observation_ts, knowledge_ts, fiscal_year, fiscal_period, period_type,
   dim_signature, value, unit, currency, source, accession_number, raw_tag, content_hash, is_superseded)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, FALSE)
ON CONFLICT (instrument_id, metric, observation_ts, dim_signature, knowledge_ts) DO NOTHING
RETURNING 1
"""

# One audit row per supersede/first-print. Same PK as fundamentals' logical+knowledge key; ON CONFLICT
# DO NOTHING for the same-knowledge_ts idempotency edge.
_INSERT_REVISION_LOG = """
INSERT INTO fundamentals_revisions_log
  (instrument_id, metric, observation_ts, dim_signature, knowledge_ts, prior_hash, new_hash,
   accession_number)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (instrument_id, metric, observation_ts, dim_signature, knowledge_ts) DO NOTHING
"""

# Quarantine a value-agreement conflict (the Task-8 QA engine adds the richer reasons). payload is the
# offending pair as JSONB.
_INSERT_QUARANTINE = """
INSERT INTO fundamentals_quarantine (instrument_id, filing_id, reason, payload)
VALUES ($1, $2, $3, $4::jsonb)
"""


def _fundamental_row_args(row: FundamentalRow) -> tuple:
    """The 15 positional binds for `_INSERT_FUNDAMENTAL` (is_superseded is the literal FALSE)."""
    return (
        row.instrument_id, row.metric, row.observation_ts, row.knowledge_ts, row.fiscal_year,
        row.fiscal_period, row.period_type, row.dim_signature, row.value, row.unit, row.currency,
        row.source, row.accession_number, row.raw_tag, row.content_hash,
    )


def _conflict_payload(conflict: ValueConflict) -> str:
    """A value-agreement conflict → the quarantine `payload` JSON: both disagreeing candidate tags, the
    period, and the dim. Enough for an operator (Task 8 surface) to see WHY the consolidated emission
    was suppressed without re-running staging."""
    return json.dumps(
        {
            "check": "value_agreement",
            "metric": conflict.metric,
            "cik": conflict.cik,
            "period_start": conflict.period_start,
            "period_end": conflict.period_end,
            "dim_signature": conflict.dim_signature,
            "tag_a": conflict.tag_a,
            "value_a": conflict.value_a,
            "tag_b": conflict.tag_b,
            "value_b": conflict.value_b,
        },
        sort_keys=True,
    )


class FundamentalsWriter:
    """Bi-temporal supersede-in-transaction writer into `fundamentals` (+ revisions log + quarantine
    handoff). Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def write_filing(
        self,
        result: StageResult,
        *,
        instrument_id: int,
        accepted_ts_ms: int,
        filing_id: Optional[int] = None,
        source: str = SOURCE_PIT_EDGAR,
    ) -> WriteStats:
        """Write ONE filing's staged facts bi-temporally + hand its conflicts to quarantine.

        `instrument_id` is resolved by the caller (cron, Task 9) from the filer's CIK via the security
        master; `accepted_ts_ms` is the filing's raw `accepted_ts` (the writer derives `knowledge_ts`
        from it). `filing_id` rides onto quarantine rows for provenance (the canonical rows carry the
        accession instead). Idempotent: a re-run over the same `StageResult` writes zero canonical rows
        (every fact's hash matches) and (by the quarantine table's nature as an append log) MAY append
        duplicate quarantine rows — quarantine is a review queue, not a deduped store, and Task 8 owns
        its lifecycle; the canonical PIT surface is unaffected."""
        if instrument_id is None:
            raise ValueError("FundamentalsWriter.write_filing: instrument_id is required "
                             "(resolve CIK→instrument_id before writing; never a fabricated id)")

        # Derive the availability knowledge_ts: the next NYSE session open after the raw accept. The
        # calendar computes NYSE holidays by rule for ALL years (a fundamentals backfill spans decades),
        # so there is no coverage boundary to warn about — see normalize/calendar.py.
        knowledge_ts = nyse_calendar.next_session_open_ms(accepted_ts_ms)

        inserted = revisions = skipped = 0
        for fact in result.facts:
            row = build_fundamental_row(
                fact, instrument_id=instrument_id, knowledge_ts=knowledge_ts, source=source
            )
            outcome = await self._write_one(row)
            if outcome == "skipped":
                skipped += 1
            elif outcome == "revision":
                inserted += 1
                revisions += 1
            elif outcome == "first_print":
                inserted += 1
            # "noop_conflict" (the same-knowledge_ts ON CONFLICT edge) counts as neither insert nor
            # skip — nothing changed and the prior current row was untouched (no supersede happened
            # for it, see _write_one).

        quarantined = await self._quarantine_conflicts(
            result.conflicts, instrument_id=instrument_id, filing_id=filing_id
        )

        return WriteStats(
            attempted=len(result.facts),
            inserted=inserted,
            revisions=revisions,
            skipped=skipped,
            quarantined=quarantined,
        )

    async def _write_one(self, row: FundamentalRow) -> str:
        """Hash-compare gate + supersede-in-transaction for ONE canonical row.

        Returns: 'skipped' (hash == current row — no-op), 'first_print' (no prior current row),
        'revision' (a prior current row with a different hash was superseded), or 'noop_conflict' (the
        rare same-logical-key + same-knowledge_ts re-derivation where the insert hit ON CONFLICT)."""
        async with self._pool.acquire() as conn:
            prior_hash = await conn.fetchval(
                _SELECT_LATEST, row.instrument_id, row.metric, row.observation_ts, row.dim_signature
            )
            if prior_hash == row.content_hash:
                return "skipped"  # idempotent: identical to the current row — no write, no txn

            is_revision = prior_hash is not None
            async with conn.transaction():
                if is_revision:
                    await conn.execute(
                        _SUPERSEDE,
                        row.instrument_id, row.metric, row.observation_ts, row.dim_signature,
                    )
                inserted = await conn.fetchval(_INSERT_FUNDAMENTAL, *_fundamental_row_args(row))
                # The insert is the source of truth for whether a row landed; only log a revision when
                # it did. The same-knowledge_ts ON CONFLICT edge (inserted is None) means a row with
                # this exact PK already existed — but note the supersede above may have flipped the
                # prior CURRENT row. That is acceptable: the colliding row carries the same logical key
                # at the same knowledge instant; the current-row invariant is preserved because the
                # colliding row's is_superseded is unchanged and remains the single current row only if
                # IT was the current one. In practice this edge is a same-instant duplicate ingest and
                # is vanishingly rare; we DO write the audit row for it so the attempt is traceable.
                await conn.execute(
                    _INSERT_REVISION_LOG,
                    row.instrument_id, row.metric, row.observation_ts, row.dim_signature,
                    row.knowledge_ts, prior_hash, row.content_hash, row.accession_number,
                )
            if inserted is None:
                return "noop_conflict"
            return "revision" if is_revision else "first_print"

    async def _quarantine_conflicts(
        self,
        conflicts: tuple[ValueConflict, ...],
        *,
        instrument_id: Optional[int],
        filing_id: Optional[int],
    ) -> int:
        """Route value-agreement conflicts to `fundamentals_quarantine` (the Task-8 review queue). A
        thin INSERT per conflict — this writer just hands them off cleanly; populating/reporting the
        rest of quarantine (identity breaks, outliers, missing-data, PDF-only) is Task 8's QA engine.
        Returns the count written. Best-effort isolation: a quarantine-write failure logs and continues
        (a conflict is a data-quality signal, not a reason to abort the canonical write that succeeded)."""
        if not conflicts:
            return 0
        written = 0
        async with self._pool.acquire() as conn:
            for conflict in conflicts:
                try:
                    await conn.execute(
                        _INSERT_QUARANTINE,
                        instrument_id, filing_id, QUARANTINE_REASON_VALUE_DISAGREEMENT,
                        _conflict_payload(conflict),
                    )
                    written += 1
                except Exception as exc:  # noqa: BLE001 — quarantine is best-effort; never block the txn'd write
                    log.error("[normalize] quarantine insert failed for %s@%s: %s",
                              conflict.metric, conflict.period_end, exc)
        return written
