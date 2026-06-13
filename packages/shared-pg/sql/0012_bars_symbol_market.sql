-- 0012_bars_symbol_market.sql — bare-ticker identity for the bars/quotes/bar_revisions_log stores.
--
-- Thread A of the PIT-fundamentals-lake epic (plan: pit-fundamentals-lake-rearchitecture.md,
-- Task 15). The concatenated Trading212 `ticker` (e.g. 'GOOGL_US_EQ') stops being the storage
-- key: every bar/quote/revision row now carries the BARE exchange symbol plus its listing market
-- as TWO separate columns — `symbol` ('GOOGL') + `market` ('US'|'LSE') — matching the
-- `TickerIdentity {symbol, market}` contract (@trader/ticker-identity). The broker `_US_EQ`/`l_EQ`
-- form is produced only at the broker boundary by the adapter; it never appears in storage again.
--
-- FLAG-DAY, NOT A BACKFILL. This is one of the coordinated terminal storage migrations (plan
-- decomposition note 1): per decision G (wipe-and-refetch, no data migration) the operator deploys
-- it together with the Task 23 store wipe, so there is NO existing data to preserve. We therefore
-- DROP and recreate the three tables with the new shape rather than fight the compressed-hypertable
-- ALTER constraints below. The data stores are repopulated post-deploy by the universe refresh +
-- poller + harvester.
--
-- Why drop-and-recreate instead of ALTER ADD/DROP COLUMN:
--   `bars`/`quotes`/`bar_revisions_log` are COMPRESSED hypertables. TimescaleDB forbids dropping a
--   column that is part of `compress_segmentby` (here `ticker`) while compression is configured, and
--   adding columns to a hypertable with compressed chunks is constrained. A wipe makes the rows
--   disposable, so the clean, deterministic move is to drop each hypertable (which drops its
--   compressed chunks with it) and recreate it new-shape. `DROP TABLE IF EXISTS … CASCADE` +
--   `CREATE TABLE IF NOT EXISTS` keeps the file idempotent and re-runnable against the running DB.
--
-- Idempotency: the whole file is wrapped by the @trader/shared-pg migration runner in one
-- transaction and recorded in `schema_migrations`, so it applies at most once per database; but the
-- statements are individually idempotent too (IF EXISTS / IF NOT EXISTS / create_hypertable
-- if_not_exists / add_compression_policy if_not_exists / DO-guarded role create) so a manual re-run
-- is safe. Applied by the `timescale-init` Helm hook each release.

-- ── bars ────────────────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS bars CASCADE;

CREATE TABLE IF NOT EXISTS bars (
  symbol             TEXT             NOT NULL,   -- bare exchange symbol, e.g. 'GOOGL'
  market             TEXT             NOT NULL CHECK (market IN ('US', 'LSE')),  -- listing market
  observation_ts     BIGINT           NOT NULL,
  knowledge_ts       BIGINT           NOT NULL,
  interval           TEXT             NOT NULL CHECK (interval IN ('5m', '15m', '1h', 'daily')),
  open               DOUBLE PRECISION NOT NULL,
  high               DOUBLE PRECISION NOT NULL,
  low                DOUBLE PRECISION NOT NULL,
  close              DOUBLE PRECISION NOT NULL,
  volume             DOUBLE PRECISION NOT NULL,
  raw_close          DOUBLE PRECISION,
  adjusted_close     DOUBLE PRECISION,
  adjustment_factor  DOUBLE PRECISION,
  currency           TEXT,
  content_hash       TEXT             NOT NULL,
  is_superseded      BOOLEAN          NOT NULL DEFAULT FALSE,
  PRIMARY KEY (symbol, market, observation_ts, interval, knowledge_ts)
);

SELECT create_hypertable(
  'bars',
  'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint,
  if_not_exists       => TRUE
);

-- Live-read fast lane — exactly one row per logical bar when filtered by is_superseded:false.
-- Mirrors Mongo's bar_latest_unique (now keyed on (symbol, market, …)).
CREATE UNIQUE INDEX IF NOT EXISTS bars_latest_unique
  ON bars (symbol, market, observation_ts, interval)
  WHERE is_superseded = FALSE;

-- As-of read predicate. Covers `WHERE symbol=$ AND market=$ AND interval=$ AND knowledge_ts <= $`.
CREATE INDEX IF NOT EXISTS bars_knowledge_lookup
  ON bars (symbol, market, interval, knowledge_ts DESC);

-- Single-bar at-or-before read support (getBarAtOrBefore / getDailyDepth bounded reads). Partial on
-- the unsuperseded fast lane, leading with (symbol, market) then observation_ts DESC so the
-- DESC-LIMIT-1 read seeks the name and walks newest-first; aligns with compress_orderby below. This
-- is the index that keeps the OOM-safe bounded reads pruning to a slice of chunks on the new columns
-- (epic pit-coverage-completeness §C1, re-keyed for Thread A).
CREATE INDEX IF NOT EXISTS bars_asof_lookup
  ON bars (symbol, market, interval, observation_ts DESC)
  WHERE is_superseded = FALSE;

-- Append-only role grants — BEFORE the compression policy (see 0002_bars.sql for why: grants made
-- after compression cascade to the internal _compressed_hypertable and fail). Writers: INSERT+SELECT
-- + UPDATE(is_superseded) for the supersede flow. No DELETE. Roles are created idempotently in case
-- this runs against a DB where 0002 never did (fresh store).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bars_writer') THEN
    CREATE ROLE bars_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bars_reader') THEN
    CREATE ROLE bars_reader NOLOGIN;
  END IF;
END
$$;

GRANT INSERT, SELECT ON bars TO bars_writer;
GRANT UPDATE (is_superseded) ON bars TO bars_writer;
GRANT SELECT ON bars TO bars_reader;

-- Compression. Segment by (symbol, market) — the new identity — so reads that filter by name still
-- skip past unrelated segments; order matches bars_asof_lookup / the at-or-before reads.
ALTER TABLE bars SET (
  timescaledb.compress             = TRUE,
  timescaledb.compress_segmentby   = 'symbol, market',
  timescaledb.compress_orderby     = 'observation_ts DESC, knowledge_ts DESC'
);

SELECT add_compression_policy(
  'bars',
  BIGINT '604800000',   -- 7 days in ms
  if_not_exists => TRUE
);

-- ── quotes ──────────────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS quotes CASCADE;

CREATE TABLE IF NOT EXISTS quotes (
  symbol          TEXT             NOT NULL,   -- bare exchange symbol
  market          TEXT             NOT NULL CHECK (market IN ('US', 'LSE')),
  observation_ts  BIGINT           NOT NULL,
  knowledge_ts    BIGINT           NOT NULL,
  bid             DOUBLE PRECISION,
  ask             DOUBLE PRECISION,
  mid             DOUBLE PRECISION NOT NULL,
  spread          DOUBLE PRECISION,
  spread_bps      DOUBLE PRECISION,
  bid_size        INTEGER,
  ask_size        INTEGER,
  market_state    TEXT             NOT NULL,
  source          TEXT             NOT NULL CHECK (source IN ('yahoo','synthetic','paid_feed_v1')),
  is_synthetic    BOOLEAN          NOT NULL DEFAULT FALSE,
  is_superseded   BOOLEAN          NOT NULL DEFAULT FALSE,
  content_hash    TEXT             NOT NULL,
  PRIMARY KEY (symbol, market, observation_ts, knowledge_ts)
);

SELECT create_hypertable('quotes', 'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint, if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS quotes_latest_unique
  ON quotes (symbol, market, observation_ts) WHERE is_superseded = FALSE;
CREATE INDEX IF NOT EXISTS quotes_recent
  ON quotes (symbol, market, observation_ts DESC) WHERE is_superseded = FALSE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'quotes_writer') THEN
    CREATE ROLE quotes_writer NOLOGIN;
  END IF;
END
$$;
GRANT INSERT, SELECT ON quotes TO quotes_writer;
GRANT UPDATE (is_superseded) ON quotes TO quotes_writer;
GRANT SELECT ON quotes TO bars_reader;

ALTER TABLE quotes SET (
  timescaledb.compress           = TRUE,
  timescaledb.compress_segmentby = 'symbol, market',
  timescaledb.compress_orderby   = 'observation_ts DESC, knowledge_ts DESC'
);
SELECT add_compression_policy('quotes', BIGINT '1209600000', if_not_exists => TRUE);  -- 14 days

-- ── bar_revisions_log ─────────────────────────────────────────────────────────────────────────--
-- The bars writer writes this audit row in the SAME transaction as each bar supersede+insert, so it
-- must carry the same identity. Recreate it new-shape (the other audit tables in 0003 are untouched).
DROP TABLE IF EXISTS bar_revisions_log CASCADE;

CREATE TABLE IF NOT EXISTS bar_revisions_log (
  symbol          TEXT        NOT NULL,
  market          TEXT        NOT NULL CHECK (market IN ('US', 'LSE')),
  observation_ts  BIGINT      NOT NULL,
  interval        TEXT        NOT NULL,
  knowledge_ts    BIGINT      NOT NULL,
  prior_hash      TEXT,         -- NULL for first-prints
  new_hash        TEXT        NOT NULL,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, market, observation_ts, interval, knowledge_ts)
);

SELECT create_hypertable(
  'bar_revisions_log',
  'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint,
  if_not_exists       => TRUE
);
CREATE INDEX IF NOT EXISTS bar_revisions_log_logged_at
  ON bar_revisions_log (logged_at DESC);

-- Append-only grants for bar_revisions_log (mirrors 0003_audit_tables.sql exactly: audit_writer
-- INSERT+SELECT, audit_reader SELECT — no UPDATE/DELETE). The roles are created in 0001_init.sql;
-- guard in case this runs first on a fresh store.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_writer') THEN
    CREATE ROLE audit_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_reader') THEN
    CREATE ROLE audit_reader NOLOGIN;
  END IF;
END
$$;
GRANT INSERT, SELECT ON bar_revisions_log TO audit_writer;
GRANT SELECT ON bar_revisions_log TO audit_reader;
