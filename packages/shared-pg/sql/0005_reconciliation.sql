-- 0005_reconciliation.sql — Three-way reconciliation ledger + NAV history.
--
-- Redefines the thin placeholder fills_history / reconciliation_log from 0003 into the rich
-- shapes the reconciliation loop needs, and adds nav_history. The platform data store is
-- wiped between iterations (no-legacy), so DROP+recreate is safe — no online migration.
--
-- Three-way: system state (Mongo) ↔ broker truth (T212) ↔ audit ledger (these tables).
-- Append-only at the role layer (audit_writer: INSERT+SELECT, no UPDATE/DELETE); resolutions
-- are NEW rows referencing the prior via supersedes_id, never in-place edits.

DROP TABLE IF EXISTS fills_history CASCADE;
DROP TABLE IF EXISTS reconciliation_log CASCADE;

-- ── fills_history ───────────────────────────────────────────────────────────────
-- Every observed T212 fill. `arrival_at` (order-send time) is required by Phase-3 TCA.
CREATE TABLE fills_history (
  event_id      BIGSERIAL,
  filled_at     TIMESTAMPTZ NOT NULL,
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  arrival_at    TIMESTAMPTZ,                          -- when the order was sent to T212 (TCA input)
  fill_id       TEXT        NOT NULL,                 -- T212 fill identifier
  order_id      TEXT        NOT NULL,
  signal_id     TEXT,                                 -- NULL for out-of-band (manual) fills
  ticker        TEXT        NOT NULL,
  side          TEXT        NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity      DOUBLE PRECISION NOT NULL,
  fill_price    DOUBLE PRECISION NOT NULL,
  currency      TEXT        NOT NULL,
  source        TEXT        NOT NULL DEFAULT 'fills_poller'  -- 'fills_poller' | 'reconciliation_backfill'
                  CHECK (source IN ('fills_poller', 'reconciliation_backfill')),
  payload       JSONB,
  PRIMARY KEY (event_id, filled_at)
);
SELECT create_hypertable('fills_history', 'filled_at', if_not_exists => TRUE);
CREATE UNIQUE INDEX fills_history_fill_id_unique ON fills_history (fill_id, filled_at);
CREATE INDEX fills_history_order_id ON fills_history (order_id);
CREATE INDEX fills_history_signal  ON fills_history (signal_id, filled_at) WHERE signal_id IS NOT NULL;
CREATE INDEX fills_history_ticker_time ON fills_history (ticker, filled_at DESC);

-- ── reconciliation_log ──────────────────────────────────────────────────────────
CREATE TYPE drift_type AS ENUM (
  'position_drift', 'oob_position',
  'cash_drift',
  'order_state_drift', 'oob_order',
  'missing_fill', 'duplicate_fill'
);
CREATE TYPE drift_severity   AS ENUM ('clean', 'minor', 'major', 'error');
CREATE TYPE drift_resolution AS ENUM ('open', 'auto_healed', 'operator_acknowledged', 'operator_resolved');

CREATE TABLE reconciliation_log (
  finding_id    BIGSERIAL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- cycle wall-clock
  effective_at  TIMESTAMPTZ NOT NULL,                 -- window-end the finding covers
  cycle_id      UUID        NOT NULL,                 -- groups findings from one run
  ticker        TEXT,                                 -- NULL for cash-only findings
  drift_type    drift_type,                           -- NULL when is_clean
  severity      drift_severity NOT NULL,
  is_clean      BOOLEAN     NOT NULL DEFAULT FALSE,
  system_state  JSONB,
  broker_state  JSONB,
  audit_state   JSONB,
  diff          JSONB,
  threshold     JSONB,
  resolution    drift_resolution NOT NULL DEFAULT 'open',
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,                                 -- operator id or 'auto'
  supersedes_id BIGINT,                               -- prior finding this row resolves
  content_hash  TEXT        NOT NULL,                 -- idempotency: same cycle+finding ⇒ no dup
  PRIMARY KEY (finding_id, occurred_at)
);
SELECT create_hypertable('reconciliation_log', 'occurred_at',
  chunk_time_interval => 30 * 24 * 60 * 60 * 1000::bigint, if_not_exists => TRUE);
CREATE INDEX recon_open_findings ON reconciliation_log (resolution, occurred_at DESC) WHERE resolution = 'open';
CREATE INDEX recon_ticker_window ON reconciliation_log (ticker, effective_at DESC);
CREATE INDEX recon_cycle ON reconciliation_log (cycle_id);
CREATE UNIQUE INDEX recon_content_hash ON reconciliation_log (content_hash, occurred_at);

-- ── nav_history ───────────────────────────────────────────────────────────────
CREATE TABLE nav_history (
  snapshot_id     BIGSERIAL,
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cash            DOUBLE PRECISION NOT NULL,
  positions_value DOUBLE PRECISION NOT NULL,
  nav             DOUBLE PRECISION NOT NULL,
  currency        TEXT        NOT NULL DEFAULT 'GBP',
  source          TEXT        NOT NULL,               -- 'reconciliation' | 'eod_close' | 'manual'
  PRIMARY KEY (snapshot_id, snapshot_at)
);
SELECT create_hypertable('nav_history', 'snapshot_at', if_not_exists => TRUE);
CREATE INDEX nav_recent ON nav_history (snapshot_at DESC);

-- ── Append-only grants (audit_writer/reader exist from 0001) ──────────────────────
GRANT INSERT, SELECT ON fills_history, reconciliation_log, nav_history TO audit_writer;
GRANT USAGE, SELECT ON SEQUENCE
  fills_history_event_id_seq, reconciliation_log_finding_id_seq, nav_history_snapshot_id_seq
TO audit_writer;
GRANT SELECT ON fills_history, reconciliation_log, nav_history TO audit_reader;
