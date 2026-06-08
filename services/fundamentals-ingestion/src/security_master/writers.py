"""Append-only writers for `security_master.{companies,instruments,identifiers,filings}`.

These are the upsert paths the ingestion chain uses to populate the relational security master that
the bi-temporal fact tables (0009_fundamentals.sql) join against. The four tables and their exact
columns are fixed by `packages/shared-pg/sql/0008_security_master.sql` (epic Task 1) — this module
writes those columns and nothing else.

APPEND-ONLY IS THE CONTRACT, NOT A SUGGESTION. The `secmaster_writer` role granted in 0008 holds
INSERT+SELECT and the BIGSERIAL sequence USAGE; its ONLY mutation is the single column-level
`UPDATE (sector) ON companies` granted in 0010 (the supersede-style narrow grant `bars_writer`/
`fundamentals_writer` also use). That one exception is deliberate: `companies.sector` is the SIC→QA
template (general/bank/insurance/reit/utility — a mutable classification, not the temporal dimension),
refreshed in place on the find-or-insert FOUND path so quarantine `by_sector` buckets a filer instead
of reading `(unknown)`. Everything else stays a pure append log; the temporal dimension lives entirely
in the effective-dated `identifiers` interval. So:

  * `companies`/`instruments` upserts are find-or-insert (idempotent by natural key) — never an
    in-place rewrite of identity columns. The `sector` column is the lone exception (backfilled on the
    found path, `IS DISTINCT FROM`-gated + non-null only, so a re-ingest of the same template is a
    no-op and a sector-less caller never clobbers a stored value with NULL).
  * a ticker change does NOT `UPDATE identifiers SET effective_to=…` on the prior row. Instead the
    new identifier is appended with its `effective_from` at the change instant, and the prior
    interval is closed **on read** by the resolver (resolver.py) from the ordering of `effective_from`
    values — OR, when the change date is already known at insert time (the canonical FB→META
    backfill, where META's 2022-06-09 rename is historical fact), the prior row is *inserted already
    bearing* its `effective_to` so both rows are correct from their first and only write. Either way
    no row is ever mutated. `record_ticker_change()` implements exactly this.

`filings` carries `UNIQUE (source, accession_number)`, so re-ingesting a filing is a no-op via
`ON CONFLICT DO NOTHING`; `companies`/`instruments` have no natural unique constraint in the schema,
so idempotency is enforced here with a SELECT-then-INSERT inside one transaction (a backfill re-run
must not duplicate the entity).

All methods take an injected `asyncpg.Pool` (pool.py owns construction); the writer holds no global
state and opens no socket on import.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from quant_core.fundamentals import market_of

# Identifier-type vocabulary, mirrored from 0008's column comment
# (`'ticker'|'cusip'|'sedol'|'isin'|'figi'`). Per the plan's identifier-scope constraint, ingestion
# only ever WRITES the two freely-obtainable types — ticker (from EDGAR submissions) and figi (from
# free OpenFIGI). CUSIP/ISIN/SEDOL are mostly paid and are a noted gap (NOT invented here); the
# constants are listed so the resolver and tests share one spelling, not so we fabricate the paid ones.
ID_TICKER = "ticker"
ID_FIGI = "figi"
ID_CUSIP = "cusip"
ID_ISIN = "isin"
ID_SEDOL = "sedol"
FREELY_OBTAINABLE_IDENTIFIERS = (ID_TICKER, ID_FIGI)

# `source` values for the filings table (0008 column comment).
SOURCE_SEC_EDGAR = "sec-edgar"
SOURCE_COMPANIES_HOUSE = "companies-house"

# Country codes the security master uses on `companies.country` (0008 comment: 'US' | 'GB').
COUNTRY_US = "US"
COUNTRY_GB = "GB"


@dataclass(frozen=True)
class CompanyRecord:
    """One issuing legal entity → `security_master.companies`. `cik` is the EDGAR central index key
    (stored as TEXT; zero-padding is a read-time concern). Natural identity for idempotency is the
    `cik` when present (one CIK = one US issuer), else the exact `name`."""

    name: str
    country: Optional[str] = None
    sector: Optional[str] = None
    industry: Optional[str] = None
    cik: Optional[str] = None
    lei: Optional[str] = None


@dataclass(frozen=True)
class InstrumentRecord:
    """One tradeable line under a company → `security_master.instruments`. `t212_ticker` is the join
    key to the live universe; natural identity for idempotency is `(company_id, t212_ticker)` when a
    t212 symbol is known, else `(company_id, instrument_type, exchange)`."""

    company_id: int
    instrument_type: str  # 'common' | 'adr' | 'preferred'
    exchange: Optional[str] = None
    currency: Optional[str] = None
    t212_ticker: Optional[str] = None


@dataclass(frozen=True)
class IdentifierRecord:
    """One effective-dated identifier row → `security_master.identifiers`. `effective_from` is the
    UTC-ms instant the value became valid; `effective_to` is the UTC-ms instant it stopped (NULL =
    currently active). The (type,value) over [from,to) interval is what `resolve_symbol` reads."""

    instrument_id: int
    identifier_type: str
    identifier_value: str
    effective_from: int
    effective_to: Optional[int] = None


@dataclass(frozen=True)
class FilingRecord:
    """One filing → `security_master.filings`. `filed_ts` is the filing date; `accepted_ts` is the
    EDGAR `acceptanceDateTime` (the timestamp `knowledge_ts` derives from in the fact writer, epic
    Task 7). UTC ms. `(source, accession_number)` is unique."""

    instrument_id: int
    accession_number: str
    form_type: str
    source: str
    filed_ts: Optional[int] = None
    accepted_ts: Optional[int] = None
    filing_url: Optional[str] = None
    is_amendment: bool = False


class SecurityMasterWriter:
    """Append-only upserts into the four security_master tables. Inject an asyncpg.Pool."""

    def __init__(self, pool) -> None:
        self._pool = pool

    # ── companies ───────────────────────────────────────────────────────────────
    async def upsert_company(self, company: CompanyRecord) -> int:
        """Find-or-insert a company; return its `company_id`. Idempotent by CIK (preferred) or name.

        A SEQUENTIAL backfill re-run reuses the existing row rather than appending a duplicate issuer
        (the actual requirement — the ingest worker is single-replica and processes one company at a
        time). The schema has no UNIQUE on `companies`, so this does NOT defend against two genuinely
        concurrent first-inserts of the same CIK under READ COMMITTED (both could miss the SELECT and
        insert); add a UNIQUE/ON CONFLICT if a future writer becomes multi-replica."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                if company.cik:
                    existing = await conn.fetchval(
                        "SELECT company_id FROM security_master.companies WHERE cik=$1",
                        company.cik,
                    )
                else:
                    existing = await conn.fetchval(
                        "SELECT company_id FROM security_master.companies "
                        "WHERE cik IS NULL AND name=$1",
                        company.name,
                    )
                if existing is not None:
                    company_id = int(existing)
                    # Retroactive sector backfill on the FOUND path. `sector` is the SIC→QA template
                    # (general/bank/insurance/reit/utility) — a mutable classification, not part of the
                    # effective-dated identifier history — so refreshing it in place is correct (and is
                    # the one column-level UPDATE this writer issues; see the module docstring). The
                    # `IS DISTINCT FROM` predicate makes a re-ingest of the SAME template a no-op
                    # (NULL-safe: also skips when both sides are NULL), and the non-null guard means a
                    # caller that doesn't know the sector never clobbers a stored value with NULL. This
                    # is what lets the ~21 pre-existing rows (inserted before sector was populated) gain
                    # a sector so the quarantine `by_sector` JOIN buckets them at query time.
                    if company.sector is not None:
                        await conn.execute(
                            "UPDATE security_master.companies SET sector=$1 "
                            "WHERE company_id=$2 AND sector IS DISTINCT FROM $1",
                            company.sector, company_id,
                        )
                    return company_id
                return int(
                    await conn.fetchval(
                        """INSERT INTO security_master.companies
                             (name, country, sector, industry, cik, lei)
                           VALUES ($1,$2,$3,$4,$5,$6)
                           RETURNING company_id""",
                        company.name, company.country, company.sector,
                        company.industry, company.cik, company.lei,
                    )
                )

    # ── instruments ─────────────────────────────────────────────────────────────
    async def upsert_instrument(self, instrument: InstrumentRecord) -> int:
        """Find-or-insert an instrument under a company; return its `instrument_id`. Idempotent by
        `(company_id, t212_ticker)` when a t212 symbol is set, else `(company_id, instrument_type,
        exchange)` (one common line per exchange for a company). Idempotency holds for a sequential
        re-run; like `upsert_company`, it does not guard a concurrent double-insert (no UNIQUE in the
        schema) — fine for the single-replica ingest worker."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                if instrument.t212_ticker:
                    existing = await conn.fetchval(
                        "SELECT instrument_id FROM security_master.instruments "
                        "WHERE company_id=$1 AND t212_ticker=$2",
                        instrument.company_id, instrument.t212_ticker,
                    )
                else:
                    existing = await conn.fetchval(
                        "SELECT instrument_id FROM security_master.instruments "
                        "WHERE company_id=$1 AND instrument_type=$2 "
                        "AND exchange IS NOT DISTINCT FROM $3 AND t212_ticker IS NULL",
                        instrument.company_id, instrument.instrument_type, instrument.exchange,
                    )
                if existing is not None:
                    return int(existing)
                return int(
                    await conn.fetchval(
                        """INSERT INTO security_master.instruments
                             (company_id, instrument_type, exchange, currency, t212_ticker)
                           VALUES ($1,$2,$3,$4,$5)
                           RETURNING instrument_id""",
                        instrument.company_id, instrument.instrument_type,
                        instrument.exchange, instrument.currency, instrument.t212_ticker,
                    )
                )

    # ── identifiers (effective-dated, append-only) ───────────────────────────────
    async def append_identifier(self, identifier: IdentifierRecord) -> int:
        """Append one effective-dated identifier row; return its `identifier_id`.

        Idempotent on the *exact* interval: re-appending the same
        `(instrument_id, type, value, effective_from)` returns the existing row rather than a second
        copy (a backfill re-run must not double the FB interval). It does NOT collapse two rows that
        share (type,value) but differ in `effective_from` — those are genuinely distinct validity
        intervals (a ticker reused later, e.g. a recycled symbol)."""
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                existing = await conn.fetchval(
                    """SELECT identifier_id FROM security_master.identifiers
                       WHERE instrument_id=$1 AND identifier_type=$2
                         AND identifier_value=$3 AND effective_from=$4""",
                    identifier.instrument_id, identifier.identifier_type,
                    identifier.identifier_value, identifier.effective_from,
                )
                if existing is not None:
                    return int(existing)
                return int(
                    await conn.fetchval(
                        """INSERT INTO security_master.identifiers
                             (instrument_id, identifier_type, identifier_value,
                              effective_from, effective_to)
                           VALUES ($1,$2,$3,$4,$5)
                           RETURNING identifier_id""",
                        identifier.instrument_id, identifier.identifier_type,
                        identifier.identifier_value, identifier.effective_from,
                        identifier.effective_to,
                    )
                )

    async def record_ticker_change(
        self,
        instrument_id: int,
        *,
        old_ticker: str,
        new_ticker: str,
        changed_at_ms: int,
        old_effective_from: int = 0,
    ) -> tuple[int, int]:
        """Record a ticker rename (e.g. FB→META) as TWO appended identifier rows, never an UPDATE.

        The prior ticker is appended with `effective_to = changed_at_ms` (its interval is now closed
        because we know the change date); the new ticker is appended with
        `effective_from = changed_at_ms, effective_to = NULL`. Returns the two identifier_ids.

        This is the append-only realisation of the plan's "inserts a new row + closes the prior
        (`effective_to`), never updates in place": closing the prior interval is done by *inserting it
        already-closed*, which the `secmaster_writer` role (INSERT-only, no UPDATE) permits — rather
        than mutating a previously open-ended row, which it does not. Idempotent via
        `append_identifier` (re-running the same change is a no-op).

        TWO INGESTION ORDERS, both resolve correctly:
          * BACKFILL (the rename is historical fact): this method inserts the prior ticker *already
            closed* at `changed_at_ms` and the new ticker open — the explicit `effective_to` is set on
            the first and only write of the prior row.
          * INCREMENTAL (the prior ticker was first appended OPEN while current, then the rename is
            detected later): an open `(old_ticker, old_effective_from)` row already exists, so
            `append_identifier`'s exact-interval idempotency returns it UNCHANGED (it is not mutated —
            no UPDATE grant) and only the new ticker is appended. The prior interval is then closed
            *on read* by the successor's `effective_from` (resolver.py / intervals.py) — so the FB→META
            resolution is identical whether or not the explicit `effective_to` ever landed. Passing the
            real `old_effective_from` is what lets the two writes line up on the same interval.

        `old_effective_from` defaults to 0 (epoch) so a backfilled history that only knows "this
        ticker existed before the change" still has a valid lower bound; pass the real first-seen
        instant when known."""
        old_id = await self.append_identifier(
            IdentifierRecord(
                instrument_id=instrument_id,
                identifier_type=ID_TICKER,
                identifier_value=old_ticker,
                effective_from=old_effective_from,
                effective_to=changed_at_ms,
            )
        )
        new_id = await self.append_identifier(
            IdentifierRecord(
                instrument_id=instrument_id,
                identifier_type=ID_TICKER,
                identifier_value=new_ticker,
                effective_from=changed_at_ms,
                effective_to=None,
            )
        )
        return old_id, new_id

    # ── filings ──────────────────────────────────────────────────────────────────
    async def upsert_filing(self, filing: FilingRecord) -> Optional[int]:
        """Insert a filing; idempotent via the schema's `UNIQUE (source, accession_number)`.

        Returns the new `filing_id`, or the existing one when the filing was already ingested (the
        EDGAR downloader, epic Task 5, calls this per filing and re-runs are common). Uses
        `ON CONFLICT DO NOTHING` then a SELECT fallback so a concurrent insert still yields the id."""
        async with self._pool.acquire() as conn:
            inserted = await conn.fetchval(
                """INSERT INTO security_master.filings
                     (instrument_id, accession_number, form_type, filed_ts, accepted_ts,
                      filing_url, source, is_amendment)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                   ON CONFLICT (source, accession_number) DO NOTHING
                   RETURNING filing_id""",
                filing.instrument_id, filing.accession_number, filing.form_type,
                filing.filed_ts, filing.accepted_ts, filing.filing_url,
                filing.source, filing.is_amendment,
            )
            if inserted is not None:
                return int(inserted)
            existing = await conn.fetchval(
                "SELECT filing_id FROM security_master.filings "
                "WHERE source=$1 AND accession_number=$2",
                filing.source, filing.accession_number,
            )
            return int(existing) if existing is not None else None


def country_for_ticker(t212_ticker: str) -> Optional[str]:
    """Map a T212 ticker to the security-master `country` code via the shared market router.

    Reuses `quant_core.fundamentals.market_of` (the single jurisdiction-from-suffix source of truth)
    rather than re-deriving the suffix rules: US market → 'US', UK → 'GB', anything else → None
    (country left unknown rather than guessed)."""
    m = market_of(t212_ticker)
    if m == "US":
        return COUNTRY_US
    if m == "UK":
        return COUNTRY_GB
    return None
