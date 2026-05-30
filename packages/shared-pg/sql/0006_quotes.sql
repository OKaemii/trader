-- 0006_quotes.sql — Bi-temporal bid/ask quote hypertable.
--
-- Yahoo v7/quote (primary) + synthetic high-low fallback (is_synthetic). One row per
-- (ticker, observation_ts); revisions supersede like bars (0002). Feeds the order
-- dispatcher's mid-quote drift gate, per-fill TCA, and the §29b spread liquidity filter.

CREATE TABLE IF NOT EXISTS quotes (
  ticker          TEXT             NOT NULL,
  observation_ts  BIGINT           NOT NULL,   -- when the quote applied (UTC ms)
  knowledge_ts    BIGINT           NOT NULL,   -- when we polled/computed it
  bid             DOUBLE PRECISION,
  ask             DOUBLE PRECISION,
  mid             DOUBLE PRECISION NOT NULL,
  spread          DOUBLE PRECISION,            -- ask - bid; null if synthetic-only
  spread_bps      DOUBLE PRECISION,            -- 10000 * spread / mid
  bid_size        INTEGER,
  ask_size        INTEGER,
  market_state    TEXT             NOT NULL,   -- 'REGULAR'|'PRE'|'POST'|'CLOSED'
  source          TEXT             NOT NULL CHECK (source IN ('yahoo','synthetic','paid_feed_v1')),
  is_synthetic    BOOLEAN          NOT NULL DEFAULT FALSE,
  is_superseded   BOOLEAN          NOT NULL DEFAULT FALSE,
  content_hash    TEXT             NOT NULL,
  PRIMARY KEY (ticker, observation_ts, knowledge_ts)
);

SELECT create_hypertable('quotes', 'observation_ts',
  chunk_time_interval => 7 * 24 * 60 * 60 * 1000::bigint, if_not_exists => TRUE);

CREATE UNIQUE INDEX IF NOT EXISTS quotes_latest_unique
  ON quotes (ticker, observation_ts) WHERE is_superseded = FALSE;
CREATE INDEX IF NOT EXISTS quotes_recent
  ON quotes (ticker, observation_ts DESC) WHERE is_superseded = FALSE;

-- Append-only writer role (mirrors bars_writer): INSERT+SELECT + UPDATE(is_superseded) only.
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
  timescaledb.compress_segmentby = 'ticker',
  timescaledb.compress_orderby   = 'observation_ts DESC, knowledge_ts DESC'
);
SELECT add_compression_policy('quotes', BIGINT '1209600000', if_not_exists => TRUE);  -- 14 days
