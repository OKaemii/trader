-- 0003_audit_tables.sql — Five domain-specific append-only hypertables.
--
-- Each captures a distinct kind of "thing that happened":
--   bar_revisions_log      — every supersede+insert pair from the bar writer
--   data_quality_events    — formerly Mongo `bad_ticks`; bar validator findings
--   strategy_health_log    — StrategyDecayMonitor periodic snapshots
--   risk_rejections        — RiskEngine veto records (signal blocked + reason)
--   fills_history          — every T212 fill, post-reconciliation
--   reconciliation_log     — reconciliation-loop run records (see doc #4)
--
-- All append-only at the role layer: writers get INSERT+SELECT, never UPDATE/DELETE.
-- All hypertables partitioned by the natural event timestamp.

-- ── bar_revisions_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bar_revisions_log (
  ticker          TEXT        NOT NULL,
  observation_ts  BIGINT      NOT NULL,
  interval        TEXT        NOT NULL,
  knowledge_ts    BIGINT      NOT NULL,
  prior_hash      TEXT,         -- NULL for first-prints
  new_hash        TEXT        NOT NULL,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, observation_ts, interval, knowledge_ts)
);
SELECT create_hypertable(
  'bar_revisions_log',
  'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint,
  if_not_exists       => TRUE
);
CREATE INDEX IF NOT EXISTS bar_revisions_log_logged_at
  ON bar_revisions_log (logged_at DESC);

-- ── data_quality_events (was Mongo `bad_ticks`) ───────────────────────────────
CREATE TABLE IF NOT EXISTS data_quality_events (
  event_id    BIGSERIAL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker      TEXT        NOT NULL,
  type        TEXT        NOT NULL,    -- 'gap' | 'stale' | 'validator' | 'revision_zscore_anomaly' | …
  payload     JSONB       NOT NULL,
  PRIMARY KEY (event_id, occurred_at)
);
SELECT create_hypertable('data_quality_events', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS data_quality_events_ticker_time
  ON data_quality_events (ticker, occurred_at DESC);

-- ── strategy_health_log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS strategy_health_log (
  event_id      BIGSERIAL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  strategy_id   TEXT        NOT NULL,
  metrics       JSONB       NOT NULL,    -- ic_rolling, hit_rate, dispersion, …
  decision      TEXT        NOT NULL,    -- 'healthy' | 'degraded' | 'paused'
  PRIMARY KEY (event_id, occurred_at)
);
SELECT create_hypertable('strategy_health_log', 'occurred_at', if_not_exists => TRUE);

-- ── risk_rejections ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_rejections (
  event_id    BIGSERIAL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticker      TEXT        NOT NULL,
  signal_id   TEXT,
  reason      TEXT        NOT NULL,
  payload     JSONB       NOT NULL,
  PRIMARY KEY (event_id, occurred_at)
);
SELECT create_hypertable('risk_rejections', 'occurred_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS risk_rejections_ticker_time
  ON risk_rejections (ticker, occurred_at DESC);

-- ── fills_history ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fills_history (
  event_id      BIGSERIAL,
  filled_at     TIMESTAMPTZ NOT NULL,
  order_id      TEXT        NOT NULL,
  signal_id     TEXT,
  ticker        TEXT        NOT NULL,
  side          TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity      DOUBLE PRECISION NOT NULL,
  fill_price    DOUBLE PRECISION NOT NULL,
  currency      TEXT        NOT NULL,
  payload       JSONB,
  PRIMARY KEY (event_id, filled_at)
);
SELECT create_hypertable('fills_history', 'filled_at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS fills_history_order_id
  ON fills_history (order_id);
CREATE INDEX IF NOT EXISTS fills_history_ticker_time
  ON fills_history (ticker, filled_at DESC);

-- ── reconciliation_log ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reconciliation_log (
  event_id    BIGSERIAL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  domain      TEXT        NOT NULL,     -- 'orders' | 'positions' | 'fills'
  status      TEXT        NOT NULL,     -- 'clean' | 'drift_detected' | 'auto_repaired'
  payload     JSONB       NOT NULL,
  PRIMARY KEY (event_id, occurred_at)
);
SELECT create_hypertable('reconciliation_log', 'occurred_at', if_not_exists => TRUE);

-- ── Append-only role grants ────────────────────────────────────────────────────
-- The same `audit_writer` / `audit_reader` roles from 0001_init.sql cover these
-- tables. INSERT+SELECT only; no UPDATE or DELETE granted, so a buggy `UPDATE`
-- gets a permission error at the wire layer.
GRANT INSERT, SELECT ON
  bar_revisions_log,
  data_quality_events,
  strategy_health_log,
  risk_rejections,
  fills_history,
  reconciliation_log
TO audit_writer;

GRANT USAGE, SELECT ON
  data_quality_events_event_id_seq,
  strategy_health_log_event_id_seq,
  risk_rejections_event_id_seq,
  fills_history_event_id_seq,
  reconciliation_log_event_id_seq
TO audit_writer;

GRANT SELECT ON
  bar_revisions_log,
  data_quality_events,
  strategy_health_log,
  risk_rejections,
  fills_history,
  reconciliation_log
TO audit_reader;
