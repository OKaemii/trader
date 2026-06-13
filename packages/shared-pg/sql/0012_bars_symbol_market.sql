-- shared-pg:no-transaction
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
-- ALTER constraints (you cannot drop a column that is part of `compress_segmentby` — here `ticker`).
-- The stores are repopulated post-deploy by the universe refresh + poller + harvester.
--
-- ⚠ RUNS NON-TRANSACTIONALLY (the `-- shared-pg:no-transaction` directive above). A plain
-- `DROP TABLE` of a DEEP hypertable takes an AccessExclusiveLock on EVERY chunk at once; the live
-- `bars` daily series spans ~1000+ 7-day chunks, so dropping it inside ONE transaction overflows the
-- shared lock table → "out of shared memory" / SQLSTATE 53200 / LockAcquireExtended (the exact
-- lock-fan the bars OOM work fights — and the reason the first cut of this migration failed the live
-- timescale-init deploy while passing the fresh-container test). So the file first drops each
-- hypertable's chunks in BOUNDED 2-year windows — each `drop_chunks` is its own auto-committed
-- statement (no wrapping BEGIN), so it locks only that window's chunks and releases them before the
-- next — leaving an (almost) empty hypertable that `DROP TABLE` can then drop cheaply. Because there
-- is no wrapping transaction, the file is written strictly idempotently (IF EXISTS / IF NOT EXISTS /
-- if_not_exists / DO-guards) so a re-run after a partial failure completes it; `schema_migrations`
-- records it only on full success. Applied by the `timescale-init` Helm hook each release.

-- ── 1. Empty the deep hypertables chunk-by-chunk (bounded locks) BEFORE dropping them ────────────
-- bars: drop chunks in bounded 2y windows. Each DO block is ONE auto-committed
-- statement (no wrapping txn — see the no-transaction directive), so it locks only that
-- window's chunks and releases them before the next. The hypertable guard makes it safe
-- on a fresh DB / after a partial prior run (table absent or not yet a hypertable).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bars') THEN PERFORM drop_chunks('bars', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;

-- quotes: drop chunks in bounded 2y windows. Each DO block is ONE auto-committed
-- statement (no wrapping txn — see the no-transaction directive), so it locks only that
-- window's chunks and releases them before the next. The hypertable guard makes it safe
-- on a fresh DB / after a partial prior run (table absent or not yet a hypertable).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='quotes') THEN PERFORM drop_chunks('quotes', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;

-- bar_revisions_log: drop chunks in bounded 2y windows. Each DO block is ONE auto-committed
-- statement (no wrapping txn — see the no-transaction directive), so it locks only that
-- window's chunks and releases them before the next. The hypertable guard makes it safe
-- on a fresh DB / after a partial prior run (table absent or not yet a hypertable).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='bar_revisions_log') THEN PERFORM drop_chunks('bar_revisions_log', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;
-- ── 2. Drop & recreate the tables with the (symbol, market) shape ───────────────────────────────
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
