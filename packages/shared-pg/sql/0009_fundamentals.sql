-- 0009_fundamentals.sql — Bi-temporal fundamentals facts + raw zone + audit/quarantine.
--
-- Mirrors 0002_bars.sql 1:1 for the canonical `fundamentals` table — the
-- bi-temporal contract is identical, just keyed on a fact tuple instead of a bar:
--   observation_ts = fiscal period_end (UTC ms)             [bars: bar open]
--   knowledge_ts   = DERIVED availability — next session    [bars: row-written ts]
--                    open after the filing's accepted_ts
--   is_superseded  = TRUE for any revision replaced by a newer one in the same
--                    (instrument_id, metric, observation_ts, dim_signature) tuple
--   content_hash   = SHA-1 over (metric, observation_ts, value, unit, currency,
--                    dim_signature); identical re-ingest is a no-op (same as bars)
--
-- A restatement (10-K/A, UK amendment) re-reports a period → new row with a higher
-- knowledge_ts, the prior row flipped is_superseded inside the same transaction.
-- The originally-reported value is never overwritten, so an as-of read at the
-- original date returns the first-print (as-first-reported) value.
--
-- See the fundamentals normalize writer (PIT-fundamentals epic Task 7), which is
-- the persist-bars.ts analogue for this table (hash-gate → supersede+insert txn).
--
-- Three zones + a quarantine table:
--   fundamentals_raw_facts    — every us-gaap:* / dei:* fact as-ingested (raw zone;
--                               re-ingest is expensive, so preserve everything)
--   fundamentals              — normalized canonical long facts (the PIT read surface)
--   fundamentals_revisions_log — one row per supersede/first-print (audit)
--   fundamentals_quarantine   — QA failures (identity break / outlier / missing)
--                               held out of the canonical table for manual review

-- ── fundamentals_raw_facts (raw zone) ─────────────────────────────────────────
-- Full preservation of every parsed fact, undeduplicated. period_end is the
-- hypertable time dimension (bigint-ms, so chunk_time_interval is bigint-ms too).
CREATE TABLE IF NOT EXISTS fundamentals_raw_facts (
  filing_id       BIGINT           NOT NULL,
  raw_tag         TEXT             NOT NULL,   -- 'us-gaap:NetIncomeLoss', 'dei:EntityCommonStockSharesOutstanding'
  taxonomy        TEXT             NOT NULL,   -- 'us-gaap'|'dei'|'ifrs-full'|frc taxonomy id
  context_id      TEXT,                        -- XBRL context (segment/period framing)
  period_type     TEXT             NOT NULL CHECK (period_type IN ('instant', 'duration')),
  period_start    BIGINT,
  period_end      BIGINT           NOT NULL,   -- observation
  knowledge_ts    BIGINT           NOT NULL,
  value           DOUBLE PRECISION,
  unit            TEXT,
  currency        TEXT,
  dim_signature   TEXT             NOT NULL DEFAULT '',   -- '' = consolidated/undimensioned
  content_hash    TEXT             NOT NULL,
  -- context_id can be NULL but is part of the natural key. Coalesce to '' so the
  -- PK stays enforceable (NULLs are distinct in a UNIQUE/PK and would let dupes in).
  PRIMARY KEY (filing_id, raw_tag, period_end, knowledge_ts, dim_signature)
);
-- ~90-day chunks. chunk_time_interval is bigint-ms because period_end is BIGINT.
SELECT create_hypertable(
  'fundamentals_raw_facts',
  'period_end',
  chunk_time_interval => 7776000000::bigint,   -- 90 days in ms
  if_not_exists       => TRUE
);
CREATE INDEX IF NOT EXISTS fundamentals_raw_facts_filing_lookup
  ON fundamentals_raw_facts (filing_id, raw_tag);

-- ── fundamentals (normalized canonical facts — the PIT read surface) ───────────
-- One row per (instrument, metric, period, dim, knowledge_ts). Pivoted to the
-- snake_case line-item dict on read (the seam's hot path).
CREATE TABLE IF NOT EXISTS fundamentals (
  instrument_id    BIGINT           NOT NULL,
  metric           TEXT             NOT NULL,   -- canonical: 'net_income','total_equity','total_assets',…
  observation_ts   BIGINT           NOT NULL,   -- fiscal period_end
  knowledge_ts     BIGINT           NOT NULL,   -- DERIVED availability (next session after accepted_ts)
  fiscal_year      INT,
  fiscal_period    TEXT,                         -- 'FY'|'Q1'|'Q2'|'Q3'
  period_type      TEXT             NOT NULL,    -- 'instant'|'duration'
  dim_signature    TEXT             NOT NULL DEFAULT '',
  value            DOUBLE PRECISION,
  unit             TEXT,
  currency         TEXT,
  source           TEXT             NOT NULL,    -- 'pit-edgar' | 'pit-companies-house'
  accession_number TEXT,                         -- provenance back to the filing …
  raw_tag          TEXT,                         -- … and the chosen us-gaap/dei tag
  content_hash     TEXT             NOT NULL,
  is_superseded    BOOLEAN          NOT NULL DEFAULT FALSE,
  PRIMARY KEY (instrument_id, metric, observation_ts, dim_signature, knowledge_ts)
);
-- ~90-day chunks. bigint-ms because observation_ts is BIGINT.
SELECT create_hypertable(
  'fundamentals',
  'observation_ts',
  chunk_time_interval => 7776000000::bigint,   -- 90 days in ms
  if_not_exists       => TRUE
);

-- Live-read fast lane — partial-unique index, exactly one current row per logical
-- fact when filtered by is_superseded:false. Mirrors bars_latest_unique (0002).
CREATE UNIQUE INDEX IF NOT EXISTS fundamentals_latest_unique
  ON fundamentals (instrument_id, metric, observation_ts, dim_signature)
  WHERE is_superseded = FALSE;

-- As-of read predicate. Covers
-- `WHERE instrument_id=$1 AND metric=$2 AND knowledge_ts <= $3 ORDER BY knowledge_ts DESC`.
-- Mirrors bars_knowledge_lookup (0002).
CREATE INDEX IF NOT EXISTS fundamentals_knowledge_lookup
  ON fundamentals (instrument_id, metric, knowledge_ts DESC);

-- ── fundamentals_revisions_log (audit) ────────────────────────────────────────
-- One row per supersede/first-print pair from the normalize writer. prior_hash
-- NULL = first-print; a non-NULL prior_hash distinguishes "this period was
-- restated" from "this fact just landed". Mirrors bar_revisions_log (0003).
CREATE TABLE IF NOT EXISTS fundamentals_revisions_log (
  instrument_id    BIGINT      NOT NULL,
  metric           TEXT        NOT NULL,
  observation_ts   BIGINT      NOT NULL,
  dim_signature    TEXT        NOT NULL DEFAULT '',
  knowledge_ts     BIGINT      NOT NULL,
  prior_hash       TEXT,                        -- NULL for first-prints
  new_hash         TEXT        NOT NULL,
  accession_number TEXT,                        -- the filing that drove this revision
  logged_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (instrument_id, metric, observation_ts, dim_signature, knowledge_ts)
);
SELECT create_hypertable(
  'fundamentals_revisions_log',
  'observation_ts',
  chunk_time_interval => 7776000000::bigint,   -- 90 days in ms
  if_not_exists       => TRUE
);
CREATE INDEX IF NOT EXISTS fundamentals_revisions_log_logged_at
  ON fundamentals_revisions_log (logged_at DESC);

-- ── fundamentals_quarantine (QA review queue) ─────────────────────────────────
-- Facts (or whole filings) that failed a QA check — sector identity break, outlier,
-- missing required line item, or a PDF-only UK group-accounts filing with no iXBRL.
-- Held out of the canonical table; the name degrades to {} downstream (never a
-- fabricated value) and surfaces on the admin quarantine list for manual review.
CREATE TABLE IF NOT EXISTS fundamentals_quarantine (
  event_id      BIGSERIAL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  instrument_id BIGINT,                          -- nullable: a filing may fail before instrument resolution
  filing_id     BIGINT,
  reason        TEXT        NOT NULL,            -- 'identity_break' | 'outlier' | 'missing_data' | 'pdf_only' | …
  payload       JSONB       NOT NULL,            -- the offending facts + the check that failed
  PRIMARY KEY (event_id, occurred_at)
);
SELECT create_hypertable('fundamentals_quarantine', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS fundamentals_quarantine_instrument_time
  ON fundamentals_quarantine (instrument_id, occurred_at DESC);

-- ── Append-only role grants ────────────────────────────────────────────────────
-- Must come BEFORE the compression policy on `fundamentals` below: Timescale's
-- compression sets up an internal `_compressed_hypertable_N` whose column set
-- differs, and a later column-level GRANT (UPDATE(is_superseded)) would cascade
-- there and fail. Grants made before compression apply to the main table only.
--
-- Writers get INSERT+SELECT plus UPDATE on is_superseded specifically (the
-- supersede flow flips that one column on `fundamentals`). No DELETE; revisions
-- are kept forever. Mirror bars_writer (0002) / features_writer (0004).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fundamentals_writer') THEN
    CREATE ROLE fundamentals_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fundamentals_reader') THEN
    CREATE ROLE fundamentals_reader NOLOGIN;
  END IF;
END
$$;

GRANT INSERT, SELECT ON
  fundamentals_raw_facts,
  fundamentals,
  fundamentals_revisions_log,
  fundamentals_quarantine
TO fundamentals_writer;

-- The supersede flow flips is_superseded on the canonical table only.
GRANT UPDATE (is_superseded) ON fundamentals TO fundamentals_writer;

GRANT USAGE, SELECT ON SEQUENCE
  fundamentals_quarantine_event_id_seq
TO fundamentals_writer;

GRANT SELECT ON
  fundamentals_raw_facts,
  fundamentals,
  fundamentals_revisions_log,
  fundamentals_quarantine
TO fundamentals_reader;

-- ── Compression ────────────────────────────────────────────────────────────────
-- Chunks older than 90 days compress at the segment level — Timescale compresses
-- rows within each segment_by group (per instrument_id) so reads that filter by
-- instrument still skip past unrelated segments. Mirrors bars (0002).
ALTER TABLE fundamentals SET (
  timescaledb.compress           = TRUE,
  timescaledb.compress_segmentby = 'instrument_id',
  timescaledb.compress_orderby   = 'observation_ts DESC, knowledge_ts DESC'
);

-- compress_after must be an INTEGER (ms) when the time dimension is BIGINT, not an
-- INTERVAL. 90 days in ms = 7_776_000_000.
SELECT add_compression_policy(
  'fundamentals',
  BIGINT '7776000000',
  if_not_exists => TRUE
);

-- The raw-fact zone is also large and append-mostly; compress old chunks too.
ALTER TABLE fundamentals_raw_facts SET (
  timescaledb.compress           = TRUE,
  timescaledb.compress_segmentby = 'filing_id',
  timescaledb.compress_orderby   = 'period_end DESC, knowledge_ts DESC'
);
SELECT add_compression_policy(
  'fundamentals_raw_facts',
  BIGINT '7776000000',
  if_not_exists => TRUE
);
