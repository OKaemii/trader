-- 0002_bars.sql — Bi-temporal OHLCV bar hypertable.
--
-- Mirrors the Mongo schema from agent-docs/plans/point-in-time-bar-history.md
-- 1:1. Storage is always 5m; coarser intervals are derived on read by
-- aggregateBars in @trader/shared-bars (matching the existing live behaviour —
-- no second source of truth for "daily bars").
--
-- Bi-temporal contract:
--   observation_ts = UTC ms describing the bar's open
--   knowledge_ts   = UTC ms the row was written
--   is_superseded  = TRUE for any revision that's been replaced by a newer one
--                    in the same (ticker, observation_ts, interval) tuple
--
-- See pg-bar-writer.ts (three-database-split task 5) for the supersede+insert
-- transactional write path.

CREATE TABLE IF NOT EXISTS bars (
  ticker             TEXT             NOT NULL,
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
  PRIMARY KEY (ticker, observation_ts, interval, knowledge_ts)
);

-- 7-day chunks. chunk_time_interval is bigint-ms because observation_ts is BIGINT.
-- At 200 tickers × 78 5m bars/day × 7 days = ~109k rows/chunk — well-sized.
SELECT create_hypertable(
  'bars',
  'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint,
  if_not_exists       => TRUE
);

-- Live-read fast lane — partial-unique index, exactly one row per logical bar
-- when filtered by is_superseded:false. Mirrors Mongo's bar_latest_unique index.
CREATE UNIQUE INDEX IF NOT EXISTS bars_latest_unique
  ON bars (ticker, observation_ts, interval)
  WHERE is_superseded = FALSE;

-- As-of read predicate. Covers `WHERE ticker=$1 AND interval=$2 AND knowledge_ts <= $3`.
CREATE INDEX IF NOT EXISTS bars_knowledge_lookup
  ON bars (ticker, interval, knowledge_ts DESC);

-- Append-only role grants. Must come BEFORE the compression policy below:
-- Timescale's compression sets up an internal `_compressed_hypertable_N` table
-- whose column set differs from `bars`; later column-level GRANTs would cascade
-- there and fail. Grants made BEFORE compression are applied to the main table
-- only and don't cascade to the compressed sibling.
--
-- Writers need INSERT + SELECT (so they can verify their own writes) plus
-- UPDATE on `is_superseded` specifically — the supersede flow flips that one
-- column. No DELETE granted; revisions are kept forever.
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

-- Compression. Chunks older than 7 days compress at the segment level — Timescale
-- compresses rows within each segment_by group (per ticker) so reads that filter
-- by ticker still skip past unrelated segments.
ALTER TABLE bars SET (
  timescaledb.compress             = TRUE,
  timescaledb.compress_segmentby   = 'ticker',
  timescaledb.compress_orderby     = 'observation_ts DESC, knowledge_ts DESC'
);

-- compress_after must be an INTEGER (ms) when the hypertable's time dimension is
-- BIGINT, not an INTERVAL. 7 days in ms = 604_800_000.
SELECT add_compression_policy(
  'bars',
  BIGINT '604800000',
  if_not_exists => TRUE
);
