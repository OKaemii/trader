-- shared-pg:no-transaction
-- 0013_drop_fundamentals.sql — teardown of the OLD Timescale PIT-fundamentals stack.
--
-- Closer of the PIT-fundamentals-lake epic (plan: pit-fundamentals-lake-rearchitecture.md, Task 24).
-- The bi-temporal `fundamentals` warehouse and its relational `security_master` are RETIRED: the
-- point-in-time fundamentals system now lives entirely in the per-CIK Parquet data-lake
-- (fundamentals-harvester writes it, fundamentals-api reads it, backtest reads it directly). Nothing
-- outside the now-deleted `fundamentals-ingestion` service read these tables (the harvester's
-- freshness audit + the backtest warehouse reader are lake-native; the only residual references were
-- their docstrings) — verified by grep before this drop. So the schema goes away wholesale.
--
-- This DROPS:
--   0009 — fundamentals (HYPERTABLE), fundamentals_raw_facts (HYPERTABLE),
--          fundamentals_revisions_log (HYPERTABLE), fundamentals_quarantine (hypertable, small),
--          + roles fundamentals_writer / fundamentals_reader.
--   0008 — the `security_master` schema (companies / instruments / identifiers / filings),
--          + roles secmaster_writer / secmaster_reader.
--
-- ⚠ RUNS NON-TRANSACTIONALLY (the `-- shared-pg:no-transaction` directive above) for the SAME reason
-- 0012 did: `fundamentals` + `fundamentals_raw_facts` + `fundamentals_revisions_log` are DEEP
-- hypertables. A plain `DROP TABLE` takes an AccessExclusiveLock on EVERY chunk at once; a live
-- warehouse spanning hundreds/thousands of 90-day chunks overflows the shared lock table inside ONE
-- transaction → "out of shared memory" / SQLSTATE 53200 / LockAcquireExtended — the EXACT lock-fan
-- that bit the bars `DROP TABLE` (fixed in PR #175 / 0012). So this file first empties each deep
-- hypertable's chunks in BOUNDED 2-year windows — each `drop_chunks` is its own auto-committed
-- statement (no wrapping BEGIN), so it locks only that window's chunks and releases them before the
-- next — leaving an (almost) empty hypertable that `DROP TABLE` can then drop cheaply.
--
-- Because there is no wrapping transaction, every statement is written strictly idempotently
-- (IF EXISTS / the hypertable guard / DROP ROLE IF EXISTS) so a re-run after a partial failure
-- completes it; `schema_migrations` records the file only on full success. Applied by the
-- `timescale-init` Helm hook each release. The window bounds (1990→2036, 2y steps) match 0012's and
-- comfortably bracket every real fiscal-period_end / knowledge_ts the warehouse ever held.
--
-- `fundamentals_quarantine` is NOT bounded-dropped: its time dimension is `occurred_at`
-- (a TIMESTAMPTZ, ~7-day default chunks) and it only ever held QA-failure events since the last
-- deploy — a handful of recent chunks, nowhere near the lock budget — so a direct `DROP TABLE` is
-- safe for it.

-- ── 1. Empty the deep fundamentals hypertables chunk-by-chunk (bounded locks) BEFORE dropping ─────
-- fundamentals (the canonical PIT fact surface) — bounded 2y-window drop_chunks. Each DO
-- block is ONE auto-committed statement (no wrapping txn — see the no-transaction directive), so it
-- locks only that window's chunks and releases them before the next. The hypertable guard keeps it
-- safe on a fresh DB / after a partial prior run (table absent or not yet a hypertable).
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals') THEN PERFORM drop_chunks('fundamentals', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;

-- fundamentals_raw_facts (the append-only raw zone — the LARGEST table) — bounded 2y-window
-- drop_chunks, one auto-committed statement each. Same lock-bounding as above.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_raw_facts') THEN PERFORM drop_chunks('fundamentals_raw_facts', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;

-- fundamentals_revisions_log (the supersede/first-print audit) — bounded 2y-window drop_chunks,
-- one auto-committed statement each. Same lock-bounding as above.
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 694224000000::bigint, newer_than => 631152000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 757382400000::bigint, newer_than => 694224000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 820454400000::bigint, newer_than => 757382400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 883612800000::bigint, newer_than => 820454400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 946684800000::bigint, newer_than => 883612800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1009843200000::bigint, newer_than => 946684800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1072915200000::bigint, newer_than => 1009843200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1136073600000::bigint, newer_than => 1072915200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1199145600000::bigint, newer_than => 1136073600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1262304000000::bigint, newer_than => 1199145600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1325376000000::bigint, newer_than => 1262304000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1388534400000::bigint, newer_than => 1325376000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1451606400000::bigint, newer_than => 1388534400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1514764800000::bigint, newer_than => 1451606400000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1577836800000::bigint, newer_than => 1514764800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1640995200000::bigint, newer_than => 1577836800000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1704067200000::bigint, newer_than => 1640995200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1767225600000::bigint, newer_than => 1704067200000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1830297600000::bigint, newer_than => 1767225600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1893456000000::bigint, newer_than => 1830297600000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 1956528000000::bigint, newer_than => 1893456000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 2019686400000::bigint, newer_than => 1956528000000::bigint); END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name='fundamentals_revisions_log') THEN PERFORM drop_chunks('fundamentals_revisions_log', older_than => 2082758400000::bigint, newer_than => 2019686400000::bigint); END IF; END $$;

-- ── 2. Drop the (now near-empty) 0009 fundamentals tables ─────────────────────────────────────────
-- Each its own auto-committed statement. CASCADE drops the dependent indexes + compression policy +
-- internal _compressed_hypertable in the same DROP. The bounded drop_chunks above left only the
-- empty hypertable shell, so this DROP locks a handful of (or zero) chunks — never the lock-fan.
DROP TABLE IF EXISTS fundamentals CASCADE;
DROP TABLE IF EXISTS fundamentals_raw_facts CASCADE;
DROP TABLE IF EXISTS fundamentals_revisions_log CASCADE;
-- Small + recent (occurred_at timestamptz, ~7d chunks since the last deploy) — direct drop is safe.
DROP TABLE IF EXISTS fundamentals_quarantine CASCADE;

-- ── 3. Drop the 0008 security_master schema (relational; not hypertables) ─────────────────────────
-- Plain relational tables (slowly-changing dimensions), small — DROP SCHEMA CASCADE takes them +
-- their indexes + sequences in one cheap statement.
DROP SCHEMA IF EXISTS security_master CASCADE;

-- ── 4. Drop the now-unused append-only roles ──────────────────────────────────────────────────────
-- DROP ROLE has IF EXISTS. The roles were created NOLOGIN with no other dependents (the dropped
-- tables/schema held the only grants), so dropping them is clean. A re-run is a no-op (IF EXISTS).
DROP ROLE IF EXISTS fundamentals_writer;
DROP ROLE IF EXISTS fundamentals_reader;
DROP ROLE IF EXISTS secmaster_writer;
DROP ROLE IF EXISTS secmaster_reader;
