-- 0004_features.sql — Bi-temporal feature store (one row per strategy cycle).
--
-- Persists the FeatureVector that quant-core's compute_features() produces, so:
--   • live and backtest-replay share one decide() input (no drift),
--   • a signal is auditable ("what did the strategy see for AAPL at 14:32?") via an
--     as-of read at the signal's knowledge-time,
--   • RegimeEngine / FeatureStabilityAnalyser can become stateless (read their window
--     from here instead of in-memory buffers).
--
-- ONE table keyed by strategy_id rather than three per-strategy tables: the JSONB
-- feature_vector already gives full per-strategy schema isolation, so separate tables
-- would be duplication without benefit. Bi-temporal contract mirrors bars (0002):
--   observation_ts = the bar-cycle instant the features summarise
--   knowledge_ts   = wall-clock instant the row was written
--   is_superseded  = TRUE once a newer revision of the same logical row replaces it
--   is_replay      = TRUE for backtest replay rows (kept out of the live fast lane)

CREATE TABLE IF NOT EXISTS features (
  strategy_id               TEXT             NOT NULL,
  observation_ts            BIGINT           NOT NULL,
  knowledge_ts              BIGINT           NOT NULL,
  feature_vector            JSONB            NOT NULL,   -- full FeatureVector (composite_scores, per_ticker, sectors, covariance, …)
  ticker_universe           TEXT[]           NOT NULL,
  regime_confidence         DOUBLE PRECISION NOT NULL,
  position_size_multiplier  DOUBLE PRECISION NOT NULL,
  content_hash              TEXT             NOT NULL,
  is_superseded             BOOLEAN          NOT NULL DEFAULT FALSE,
  is_replay                 BOOLEAN          NOT NULL DEFAULT FALSE,
  PRIMARY KEY (strategy_id, observation_ts, knowledge_ts, is_replay)
);

-- 30-day chunks (daily cadence → ~30 rows/strategy/chunk; intraday more). bigint-ms.
SELECT create_hypertable(
  'features',
  'observation_ts',
  chunk_time_interval => 30 * 24 * 60 * 60 * 1000::bigint,
  if_not_exists       => TRUE
);

-- Live-read fast lane — exactly one live (non-replay, unsuperseded) row per logical cycle.
CREATE UNIQUE INDEX IF NOT EXISTS features_latest_unique
  ON features (strategy_id, observation_ts)
  WHERE is_superseded = FALSE AND is_replay = FALSE;

-- As-of read predicate: `WHERE strategy_id=$1 AND knowledge_ts <= $2 ORDER BY knowledge_ts DESC`.
CREATE INDEX IF NOT EXISTS features_knowledge_lookup
  ON features (strategy_id, knowledge_ts DESC);

-- Replay-row lookup (per strategy, by observation_ts) — keeps replay analytics off the
-- live partial index.
CREATE INDEX IF NOT EXISTS features_replay_lookup
  ON features (strategy_id, is_replay, observation_ts DESC);

-- Append-only role. Writers get INSERT + SELECT + UPDATE(is_superseded) for the supersede
-- flow; no DELETE. Grants BEFORE compression so they don't cascade to the compressed sibling.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'features_writer') THEN
    CREATE ROLE features_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'features_reader') THEN
    CREATE ROLE features_reader NOLOGIN;
  END IF;
END
$$;

GRANT INSERT, SELECT ON features TO features_writer;
GRANT UPDATE (is_superseded) ON features TO features_writer;
GRANT SELECT ON features TO features_reader;

ALTER TABLE features SET (
  timescaledb.compress           = TRUE,
  timescaledb.compress_segmentby = 'strategy_id',
  timescaledb.compress_orderby   = 'observation_ts DESC, knowledge_ts DESC'
);

-- 30 days in ms.
SELECT add_compression_policy('features', BIGINT '2592000000', if_not_exists => TRUE);
