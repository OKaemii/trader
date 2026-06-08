"""Append-only writer for `fundamentals_raw_facts` — the raw zone (epic Task 5).

Writes every parsed us-gaap:* / dei:* fact verbatim, BEFORE any interpretation, so the canonical
normalization (Task 6/7) is always re-derivable from source without re-hitting SEC (a re-ingest is
expensive — full preservation is the contract). One `RawFact` (from `download.edgar`) + the filing it
came from → one `fundamentals_raw_facts` row.

THE PK CONTRACT (from the Task-1 schema card, 0009_fundamentals.sql — a code-review fix DEVIATED from
the plan's literal PK and the writer MUST honour the deployed one):
    (filing_id, raw_tag, context_id, period_type, period_end, knowledge_ts, dim_signature)
  * `context_id` is NOT NULL DEFAULT '' — the writer ALWAYS emits it (default '' when XBRL gives no
    explicit context), NEVER NULL. Two facts under different contexts must be two rows; a NULL would
    make the PK column reject the insert.
  * `period_type` ('instant'|'duration') is IN the key, so an instant fact and a duration fact that
    share a `period_end` (a balance-sheet point vs a flow ending the same day) don't collide.
  * `dim_signature` ('' = consolidated/undimensioned) closes the key — distinct segment framings of
    the same tag/period stay separate rows.

APPEND-ONLY, HASH-GATED, IDEMPOTENT (mirrors persist-bars.ts' hash-compare gate):
  * `bars_writer`/`fundamentals_writer` get a column-level UPDATE; the RAW zone gets none — it is a
    pure INSERT log, so a re-ingest of an identical fact is `INSERT … ON CONFLICT DO NOTHING`, never an
    UPDATE. `content_hash` (`content_hash.py`) makes an identical re-pull a clean no-op and exposes the
    anomalous case of the same identity arriving with a different value (which is a *canonical*
    supersede, Task 7 — not a raw overwrite).
  * The writer never deletes and never mutates a stored row; the full history of every print is kept.

knowledge_ts: STORE IT RAW. The raw zone records the genuine knowledge time as supplied by the caller
— for EDGAR that is the filing's `accepted_ts` (UTC ms; Task 4 verified EDGAR's `acceptanceDateTime`
carries a literal Z and IS genuine UTC). The UTC→ET *availability* derivation (after-hours accept →
next session open) is the CANONICAL writer's job (Task 7), NOT here — the raw zone preserves the
as-received timestamp so that derivation stays re-runnable from source. A fact whose filing has no
`accepted_ts` (SEC omitted it) is skipped rather than stamped with a fabricated knowledge_ts (it would
break the bi-temporal contract); the caller logs the skip.

All methods take an injected `asyncpg.Pool` (security_master/pool.py owns construction); the writer
holds no global state and opens no socket on import.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

from src.download.edgar import RawFact

from .content_hash import hash_raw_fact


@dataclass(frozen=True)
class RawFactRow:
    """One fully-resolved `fundamentals_raw_facts` row: a `RawFact` joined to its filing lineage.

    `filing_id` is resolved by the caller against `security_master.filings` (the downloader upserts the
    filing first, then writes its facts). `knowledge_ts` is the filing's `accepted_ts` (stored raw —
    see module docstring). `taxonomy` is split from the `raw_tag` for the column (`us-gaap` from
    `us-gaap:NetIncomeLoss`)."""

    filing_id: int
    raw_tag: str
    taxonomy: str
    context_id: str
    period_type: str
    period_start: Optional[int]
    period_end: int
    knowledge_ts: int
    value: Optional[float]
    unit: Optional[str]
    currency: Optional[str]
    dim_signature: str
    content_hash: str


def build_raw_fact_row(fact: RawFact, *, filing_id: int, knowledge_ts: int) -> RawFactRow:
    """Map a parsed `RawFact` + its filing lineage onto a `fundamentals_raw_facts` row, computing the
    content hash. Enforces the NOT-NULL-DEFAULT-'' invariant for `context_id`/`dim_signature` defensively
    (a None coming from any future parser is normalised to '' here, never written as NULL)."""
    context_id = fact.context_id or ""
    dim_signature = fact.dim_signature or ""
    digest = hash_raw_fact(
        filing_id=filing_id,
        raw_tag=fact.raw_tag,
        context_id=context_id,
        period_type=fact.period_type,
        period_start=fact.period_start,
        period_end=fact.period_end,
        knowledge_ts=knowledge_ts,
        value=fact.value,
        unit=fact.unit,
        currency=fact.currency,
        dim_signature=dim_signature,
    )
    return RawFactRow(
        filing_id=filing_id,
        raw_tag=fact.raw_tag,
        taxonomy=fact.taxonomy,
        context_id=context_id,
        period_type=fact.period_type,
        period_start=fact.period_start,
        period_end=fact.period_end,
        knowledge_ts=knowledge_ts,
        value=fact.value,
        unit=fact.unit,
        currency=fact.currency,
        dim_signature=dim_signature,
        content_hash=digest,
    )


# The single INSERT the raw zone issues. ON CONFLICT on the full natural PK → DO NOTHING (idempotent
# re-ingest). RETURNING 1 yields a row only on a fresh insert (the conflict-skip returns no row), so
# the writer counts writes-vs-skips without a second query.
_INSERT_RAW_FACT = """
INSERT INTO fundamentals_raw_facts
    (filing_id, raw_tag, taxonomy, context_id, period_type, period_start, period_end,
     knowledge_ts, value, unit, currency, dim_signature, content_hash)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (filing_id, raw_tag, context_id, period_type, period_end, knowledge_ts, dim_signature)
DO NOTHING
RETURNING 1
"""


# A filing's lineage resolved from its accession: the `filing_id` (from `security_master.filings`) and
# the `knowledge_ts` to stamp on its facts (the filing's `accepted_ts`, stored raw — the UTC→ET
# availability hop is Task 7). None means "this accession has no usable lineage" — no `filing_id`
# resolved, OR no `accepted_ts` on the filing — so its facts are SKIPPED, never written under a
# fabricated id/timestamp (that would break the bi-temporal contract). This is the *real* skip the
# raw-zone contract promises; the caller (cron, Task 9) builds the map and logs the skipped accessions.
FilingLineage = tuple[int, int]   # (filing_id, knowledge_ts)


def _row_args(row: RawFactRow) -> tuple:
    """The 13 positional binds for `_INSERT_RAW_FACT`, in column order."""
    return (
        row.filing_id, row.raw_tag, row.taxonomy, row.context_id, row.period_type,
        row.period_start, row.period_end, row.knowledge_ts, row.value, row.unit,
        row.currency, row.dim_signature, row.content_hash,
    )


class RawFactsWriter:
    """Append-only, hash-gated INSERT path into `fundamentals_raw_facts`. Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def write_row(self, row: RawFactRow) -> bool:
        """Insert one raw fact; return True if a row was written, False if it already existed (the
        ON CONFLICT no-op). Never raises on a duplicate — the raw zone is idempotent by construction."""
        async with self._pool.acquire() as conn:
            return await self._insert(conn, row)

    @staticmethod
    async def _insert(conn, row: RawFactRow) -> bool:
        """One INSERT on a supplied connection. True iff a fresh row landed (False = conflict no-op)."""
        written = await conn.fetchval(_INSERT_RAW_FACT, *_row_args(row))
        return written is not None

    async def write_facts(
        self,
        facts: Iterable[RawFact],
        *,
        filing_id: int,
        knowledge_ts: int,
    ) -> int:
        """Write all facts that belong to ONE filing — the caller has already scoped `facts` to a
        single accession and resolved its `(filing_id, knowledge_ts)`.

        Returns the count of NEWLY-written rows (re-ingested duplicates don't count). All inserts run on
        ONE pooled connection (a filing has hundreds–thousands of facts; per-fact `pool.acquire()` would
        churn the pool), each mapped to a row + hashed here.

        WARNING — this stamps the SAME `filing_id`/`knowledge_ts` on every fact, so `facts` MUST be a
        single accession's facts, NOT a whole-CIK `parse_company_facts(...)` result (that spans many
        filings). To ingest a full companyfacts payload, use `write_company_facts`, which groups by each
        fact's `accession_number` first — mixing accessions under one `filing_id` would corrupt lineage
        and inject look-ahead into the bi-temporal `knowledge_ts`."""
        written = 0
        async with self._pool.acquire() as conn:
            for fact in facts:
                row = build_raw_fact_row(fact, filing_id=filing_id, knowledge_ts=knowledge_ts)
                if await self._insert(conn, row):
                    written += 1
        return written

    async def write_company_facts(
        self,
        facts: Iterable[RawFact],
        *,
        lineage_by_accession: dict[str, FilingLineage],
    ) -> int:
        """Write a whole companyfacts payload, grouping facts by their own `accession_number` so each
        fact lands under ITS filing's `(filing_id, knowledge_ts)` — the correct entrypoint for a
        `parse_company_facts(...)` result, which spans every historical filing of a CIK.

        `lineage_by_accession` maps each accession to its resolved `(filing_id, knowledge_ts)` (the cron,
        Task 9, builds it by upserting filings via `SecurityMasterWriter.upsert_filing` and reading their
        `accepted_ts`). A fact whose accession is absent from the map — OR maps to None — is SKIPPED (no
        `filing_id`/`accepted_ts` ⇒ no honest bi-temporal stamp), never written under a fabricated id.
        Returns the count of newly-written rows. One pooled connection for the whole payload."""
        written = 0
        async with self._pool.acquire() as conn:
            for fact in facts:
                accn = fact.accession_number
                lineage = lineage_by_accession.get(accn) if accn else None
                if lineage is None:
                    continue  # unresolved accession / no accepted_ts → skip (the documented skip)
                filing_id, knowledge_ts = lineage
                row = build_raw_fact_row(fact, filing_id=filing_id, knowledge_ts=knowledge_ts)
                if await self._insert(conn, row):
                    written += 1
        return written
