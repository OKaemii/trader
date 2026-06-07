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
# re-ingest). RETURNING xmax = 0 distinguishes a fresh insert (xmax 0) from a conflict-skip (no row
# returned), so the writer can count writes-vs-skips without a second query.
_INSERT_RAW_FACT = """
INSERT INTO fundamentals_raw_facts
    (filing_id, raw_tag, taxonomy, context_id, period_type, period_start, period_end,
     knowledge_ts, value, unit, currency, dim_signature, content_hash)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
ON CONFLICT (filing_id, raw_tag, context_id, period_type, period_end, knowledge_ts, dim_signature)
DO NOTHING
RETURNING 1
"""


class RawFactsWriter:
    """Append-only, hash-gated INSERT path into `fundamentals_raw_facts`. Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    async def write_row(self, row: RawFactRow) -> bool:
        """Insert one raw fact; return True if a row was written, False if it already existed (the
        ON CONFLICT no-op). Never raises on a duplicate — the raw zone is idempotent by construction."""
        async with self._pool.acquire() as conn:
            written = await conn.fetchval(
                _INSERT_RAW_FACT,
                row.filing_id, row.raw_tag, row.taxonomy, row.context_id, row.period_type,
                row.period_start, row.period_end, row.knowledge_ts, row.value, row.unit,
                row.currency, row.dim_signature, row.content_hash,
            )
            return written is not None

    async def write_facts(
        self,
        facts: Iterable[RawFact],
        *,
        filing_id: int,
        knowledge_ts: int,
    ) -> int:
        """Write all facts for one filing (the downloader's per-filing call). Returns the count of
        NEWLY-written rows (re-ingested duplicates don't count). Each fact is mapped to a row + hashed
        here, so the caller hands raw `RawFact`s straight from the parser."""
        written = 0
        for fact in facts:
            row = build_raw_fact_row(fact, filing_id=filing_id, knowledge_ts=knowledge_ts)
            if await self.write_row(row):
                written += 1
        return written
