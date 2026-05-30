-- 0007_tca.sql — Transaction-cost analysis ledger (append-only).
--
-- One row per executed fill, fanned out from fills_history: joins the quote at the order's
-- arrival_at and at fill time to measure arrival slippage, fill slippage, and total cost in
-- bps (side-aware). NULL slippage when no quote within the freshness window — dashboards
-- exclude nulls from aggregates and show the coverage rate.

CREATE TABLE IF NOT EXISTS tca_log (
  tca_id               BIGSERIAL,
  computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fill_id              TEXT NOT NULL,
  order_id             TEXT NOT NULL,
  signal_id            TEXT,
  ticker               TEXT NOT NULL,
  side                 TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  arrival_at           TIMESTAMPTZ,
  fill_at              TIMESTAMPTZ NOT NULL,
  filled_qty           DOUBLE PRECISION NOT NULL,
  fill_price           DOUBLE PRECISION NOT NULL,
  arrival_mid          DOUBLE PRECISION,
  fill_mid             DOUBLE PRECISION,
  arrival_slip_bps     DOUBLE PRECISION,   -- side * 10000 * (fill_mid - arrival_mid)/arrival_mid
  fill_slip_bps        DOUBLE PRECISION,   -- side * 10000 * (fill_price - fill_mid)/fill_mid
  total_cost_bps       DOUBLE PRECISION,   -- side * 10000 * (fill_price - arrival_mid)/arrival_mid
  quote_arrival_source TEXT,
  quote_fill_source    TEXT,
  PRIMARY KEY (tca_id, computed_at)
);

SELECT create_hypertable('tca_log', 'computed_at',
  chunk_time_interval => 30 * 24 * 60 * 60 * 1000::bigint, if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS tca_fill_unique ON tca_log (fill_id, computed_at);
CREATE INDEX IF NOT EXISTS tca_strategy_day ON tca_log (signal_id, computed_at);
CREATE INDEX IF NOT EXISTS tca_ticker_day   ON tca_log (ticker, fill_at);

-- Append-only via the shared audit_writer role (INSERT+SELECT only).
GRANT INSERT, SELECT ON tca_log TO audit_writer;
GRANT USAGE, SELECT ON SEQUENCE tca_log_tca_id_seq TO audit_writer;
GRANT SELECT ON tca_log TO audit_reader;
