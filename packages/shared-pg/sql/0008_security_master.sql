-- 0008_security_master.sql — Relational security master for the PIT fundamentals warehouse.
--
-- Permanent, ticker-independent identity for the equities the fundamentals
-- warehouse covers, living in the same Timescale cluster as the fact hypertables
-- (0009_fundamentals.sql) so facts join to entities locally. Four tables:
--   companies    — the issuing entity (CIK / LEI carriers; one per legal issuer)
--   instruments  — the tradeable line(s) under a company (common / adr / preferred)
--   identifiers  — EFFECTIVE-DATED ticker/CUSIP/SEDOL/ISIN/FIGI with validity
--                  intervals; this is what makes resolve_symbol("META","2019-01-01")
--                  return the FB-era security rather than today's META.
--   filings      — filing lineage + the two PIT timestamps (filed vs accepted) that
--                  the bi-temporal fundamentals writer derives knowledge_ts from.
--
-- These are plain relational tables (not hypertables): they are small, slowly-
-- changing dimensions keyed by a BIGSERIAL surrogate, not time-series. The
-- bi-temporal contract lives on the fact tables in 0009; here the temporal
-- dimension is the effective-dated identifier interval.
--
-- Append-only is enforced at the role layer exactly as 0001_init.sql does it:
-- secmaster_writer holds INSERT+SELECT (+ sequence USAGE for the BIGSERIALs), no
-- UPDATE or DELETE, so a buggy write path errors at the wire layer.

CREATE SCHEMA IF NOT EXISTS security_master;

-- ── companies ─────────────────────────────────────────────────────────────────
-- The issuing legal entity. CIK is the US EDGAR central index key (stored as TEXT;
-- zero-padding to 10 digits is handled at read time). country is ISO-ish 'US'|'GB'.
CREATE TABLE IF NOT EXISTS security_master.companies (
  company_id  BIGSERIAL   PRIMARY KEY,
  name        TEXT        NOT NULL,
  country     TEXT,                          -- 'US' | 'GB'
  sector      TEXT,
  industry    TEXT,
  cik         TEXT,                          -- US EDGAR central index key
  lei         TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── instruments ───────────────────────────────────────────────────────────────
-- The tradeable line under a company. t212_ticker is the join key to the live
-- universe (the symbol the trading stack actually quotes/orders).
CREATE TABLE IF NOT EXISTS security_master.instruments (
  instrument_id   BIGSERIAL PRIMARY KEY,
  company_id      BIGINT    NOT NULL REFERENCES security_master.companies(company_id),
  instrument_type TEXT      NOT NULL,        -- 'common' | 'adr' | 'preferred'
  exchange        TEXT,
  currency        TEXT,
  t212_ticker     TEXT                       -- tradeable symbol; join key to the live universe
);
CREATE INDEX IF NOT EXISTS instruments_company_lookup
  ON security_master.instruments (company_id);
CREATE INDEX IF NOT EXISTS instruments_t212_ticker_lookup
  ON security_master.instruments (t212_ticker);

-- ── identifiers (effective-dated) ─────────────────────────────────────────────
-- ticker/CUSIP/SEDOL/ISIN/FIGI with validity intervals. effective_to NULL = the
-- currently-active identifier. The lookup index covers the as-of resolution
-- predicate `WHERE identifier_type=$1 AND identifier_value=$2 AND effective_from<=$3`.
CREATE TABLE IF NOT EXISTS security_master.identifiers (
  identifier_id    BIGSERIAL PRIMARY KEY,
  instrument_id    BIGINT    NOT NULL REFERENCES security_master.instruments(instrument_id),
  identifier_type  TEXT      NOT NULL,       -- 'ticker'|'cusip'|'sedol'|'isin'|'figi'
  identifier_value TEXT      NOT NULL,
  effective_from   BIGINT    NOT NULL,       -- UTC ms
  effective_to     BIGINT                    -- NULL = current
);
CREATE INDEX IF NOT EXISTS identifiers_lookup
  ON security_master.identifiers (identifier_type, identifier_value, effective_from);
CREATE INDEX IF NOT EXISTS identifiers_instrument_lookup
  ON security_master.identifiers (instrument_id, identifier_type);

-- ── filings ───────────────────────────────────────────────────────────────────
-- Filing lineage + the two PIT timestamps. accepted_ts (EDGAR acceptanceDateTime /
-- UK made-available) is the one knowledge_ts derives from — an after-hours
-- acceptance is only knowable next session. is_amendment flags a 10-K/A (or UK
-- amendment) that drives a restatement in the fact writer. UNIQUE(source,
-- accession_number) makes re-ingesting the same filing a no-op.
CREATE TABLE IF NOT EXISTS security_master.filings (
  filing_id         BIGSERIAL PRIMARY KEY,
  instrument_id     BIGINT    NOT NULL REFERENCES security_master.instruments(instrument_id),
  accession_number  TEXT      NOT NULL,
  form_type         TEXT      NOT NULL,      -- '10-K', '10-Q', '10-K/A', UK 'AA', …
  filed_ts          BIGINT,                  -- filing date (UTC ms)
  accepted_ts       BIGINT,                  -- EDGAR acceptanceDateTime (UTC ms); UK: made-available
  filing_url        TEXT,
  source            TEXT      NOT NULL,      -- 'sec-edgar' | 'companies-house'
  is_amendment      BOOLEAN   NOT NULL DEFAULT FALSE,
  UNIQUE (source, accession_number)
);
CREATE INDEX IF NOT EXISTS filings_instrument_lookup
  ON security_master.filings (instrument_id, accepted_ts DESC);

-- ── Append-only role grants ────────────────────────────────────────────────────
-- CREATE ROLE has no IF NOT EXISTS; wrap in a DO block that guards on pg_roles so
-- the migration is idempotent on repeat application (mirror 0001_init.sql).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'secmaster_writer') THEN
    CREATE ROLE secmaster_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'secmaster_reader') THEN
    CREATE ROLE secmaster_reader NOLOGIN;
  END IF;
END
$$;

-- USAGE on the schema is required before any table grant inside it resolves.
GRANT USAGE ON SCHEMA security_master TO secmaster_writer, secmaster_reader;

-- Writers get INSERT+SELECT (so they can verify their own writes) plus the
-- BIGSERIAL sequence USAGE. No DELETE; the security master is append-only.
GRANT INSERT, SELECT ON
  security_master.companies,
  security_master.instruments,
  security_master.identifiers,
  security_master.filings
TO secmaster_writer;

GRANT USAGE, SELECT ON SEQUENCE
  security_master.companies_company_id_seq,
  security_master.instruments_instrument_id_seq,
  security_master.identifiers_identifier_id_seq,
  security_master.filings_filing_id_seq
TO secmaster_writer;

GRANT SELECT ON
  security_master.companies,
  security_master.instruments,
  security_master.identifiers,
  security_master.filings
TO secmaster_reader;
