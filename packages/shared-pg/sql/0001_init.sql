-- 0001_init.sql — Audit log + cluster-wide append-only roles.
--
-- Lives in the live Timescale cluster as the canonical "thing that happened"
-- stream for every service that wants to record a discrete event. Distinct from
-- the per-domain audit hypertables in 0003_audit_tables.sql, which capture
-- domain-shaped events (bar revisions, fills, risk decisions); audit_log is the
-- catch-all for events that don't yet have a dedicated table.
--
-- Append-only is enforced at the role layer: audit_writer has INSERT+SELECT,
-- no UPDATE or DELETE. Services connect under audit_writer (not the cluster
-- superuser) so a buggy code path that tries to mutate a row gets a permission
-- error at the wire layer, not an after-the-fact regret.

CREATE TABLE IF NOT EXISTS audit_log (
  event_id      BIGSERIAL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source        TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  trace_id      TEXT,
  -- Hypertable partitioning key must be part of the primary key. We promote
  -- event_id + occurred_at into the PK so the BIGSERIAL still guarantees row
  -- uniqueness AND Timescale can partition by occurred_at.
  PRIMARY KEY (event_id, occurred_at)
);

SELECT create_hypertable('audit_log', 'occurred_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS audit_log_type_time
  ON audit_log (event_type, occurred_at DESC);

-- Roles. CREATE ROLE has no IF NOT EXISTS; wrap in a DO block that swallows the
-- duplicate_object error so the migration is idempotent on repeat application.
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

GRANT INSERT, SELECT ON audit_log TO audit_writer;
GRANT USAGE, SELECT ON SEQUENCE audit_log_event_id_seq TO audit_writer;
GRANT SELECT ON audit_log TO audit_reader;
