// Integration test for the migration runner. Spins up a Timescale container
// via testcontainers-node, runs the migrations twice, asserts the second run
// is a complete no-op (all files in `skipped`, none in `applied`).
//
// Gated by Docker availability — `describe.skipIf(!dockerAvailable)` so devs
// without a running Docker daemon don't see false failures. CI runs with
// Docker available; this is the path that catches real schema regressions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import pg from 'pg';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMigrations, splitSqlStatements } from '../migrations.ts';

const dockerAvailable = await isDockerAvailable();

const TEST_TIMEOUT_MS = 180_000;

// ── splitSqlStatements (pure — always runs, no Docker) ──────────────────────────────────────────
// The no-transaction migration path splits a file into statements and runs each as its own implicit
// transaction. The splitter must NOT break on a `;` inside a DO $$ … $$ block or a string literal —
// a mis-split would either send a half-statement (syntax error) or wrap multiple statements in one
// simple-Query (re-introducing the all-chunk lock fan the no-transaction mode exists to avoid).
describe('splitSqlStatements', () => {
  it('splits top-level statements on semicolons', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('does NOT split on a semicolon inside a $$ … $$ dollar-quoted block', () => {
    const sql = `DO $$ BEGIN IF TRUE THEN PERFORM drop_chunks('bars', older_than => 1::bigint); END IF; END $$;\nDROP TABLE IF EXISTS bars CASCADE;`;
    const out = splitSqlStatements(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('drop_chunks');
    expect(out[0]).toContain('END $$');
    expect(out[1]).toBe('DROP TABLE IF EXISTS bars CASCADE');
  });

  it('does NOT split on a semicolon inside a string literal', () => {
    const out = splitSqlStatements(`INSERT INTO t(c) VALUES ('a;b'); SELECT 1;`);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("'a;b'");
  });

  it('ignores trailing comments / blank lines (no empty statement)', () => {
    expect(splitSqlStatements('SELECT 1;\n-- a trailing comment\n')).toEqual(['SELECT 1']);
    expect(splitSqlStatements('-- only a comment\n')).toEqual([]);
  });

  it('keeps a final statement that has no trailing semicolon', () => {
    expect(splitSqlStatements('SELECT 1;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
});

describe.skipIf(!dockerAvailable)('runMigrations', () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;
  let sqlDir: string;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB:       'trader_ts',
      })
      .withExposedPorts(5432)
      .withCommand([
        'postgres',
        '-c', "shared_preload_libraries=timescaledb",
      ])
      .start();

    pool = new pg.Pool({
      host:     container.getHost(),
      port:     container.getMappedPort(5432),
      user:     'postgres',
      password: 'test',
      database: 'trader_ts',
    });

    // Wait for the timescaledb extension to be createable (postgres image needs
    // a moment after first boot for the cluster to be fully ready).
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    sqlDir = path.resolve(thisDir, '..', '..', 'sql');
  }, TEST_TIMEOUT_MS);

  // Derived from the directory so adding a migration file never breaks this test —
  // the runner's contract is "apply every *.sql in lexical order, idempotently".
  const expectedFiles = (): string[] =>
    readdirSync(sqlDir).filter((f) => f.endsWith('.sql')).sort();

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, TEST_TIMEOUT_MS);

  it('applies every SQL file on first run', async () => {
    const result = await runMigrations(sqlDir, pool);
    expect(result.applied).toEqual(expectedFiles());
    expect(result.skipped).toEqual([]);

    // Spot-check that the expected objects were created.
    const { rows: tables } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const tableNames = tables.map((r) => r.tablename);
    expect(tableNames).toContain('audit_log');
    expect(tableNames).toContain('bars');
    expect(tableNames).toContain('bar_revisions_log');
    expect(tableNames).toContain('fills_history');
    expect(tableNames).toContain('features');
    expect(tableNames).toContain('reconciliation_log');
    expect(tableNames).toContain('nav_history');
    expect(tableNames).toContain('quotes');
    expect(tableNames).toContain('tca_log');
    // 0009_fundamentals.sql — the four fact-zone tables.
    expect(tableNames).toContain('fundamentals_raw_facts');
    expect(tableNames).toContain('fundamentals');
    expect(tableNames).toContain('fundamentals_revisions_log');
    expect(tableNames).toContain('fundamentals_quarantine');

    // 0008_security_master.sql — the security_master schema + its four tables.
    const { rows: secmasterTables } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='security_master' ORDER BY tablename",
    );
    expect(secmasterTables.map((r) => r.tablename)).toEqual([
      'companies',
      'filings',
      'identifiers',
      'instruments',
    ]);

    // Feature-store live fast-lane partial index exists.
    const { rows: featIdx } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='features'",
    );
    expect(featIdx.map((r) => r.indexname)).toContain('features_latest_unique');

    // Partial-unique index on bars.
    const { rows: indexes } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='bars' ORDER BY indexname",
    );
    expect(indexes.map((r) => r.indexname)).toContain('bars_latest_unique');

    // Fundamentals live fast-lane partial-unique index + as-of lookup index exist.
    const { rows: fundIdx } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename='fundamentals'",
    );
    const fundIdxNames = fundIdx.map((r) => r.indexname);
    expect(fundIdxNames).toContain('fundamentals_latest_unique');
    expect(fundIdxNames).toContain('fundamentals_knowledge_lookup');

    // Identifier effective-dated lookup index exists.
    const { rows: identIdx } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='security_master' AND tablename='identifiers'",
    );
    expect(identIdx.map((r) => r.indexname)).toContain('identifiers_lookup');

    // Append-only roles from every migration exist.
    const { rows: roles } = await pool.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('audit_writer','bars_writer','secmaster_writer','secmaster_reader','fundamentals_writer','fundamentals_reader')",
    );
    expect(roles.length).toBe(6);
  }, TEST_TIMEOUT_MS);

  it('enforces the fundamentals bi-temporal contract (partial-unique + append-only roles)', async () => {
    // Two revisions of the same logical fact: the live partial-unique index allows
    // both only because exactly one is is_superseded=FALSE. This proves the
    // supersede-in-transaction contract the writer relies on (mirror of bars).
    await pool.query(`
      INSERT INTO fundamentals
        (instrument_id, metric, observation_ts, knowledge_ts, period_type,
         value, source, content_hash, is_superseded)
      VALUES
        (1, 'net_income', 1577836800000, 1580000000000, 'duration', 100.0, 'pit-edgar', 'h1', TRUE),
        (1, 'net_income', 1577836800000, 1590000000000, 'duration', 110.0, 'pit-edgar', 'h2', FALSE)
    `);

    // A second live (is_superseded=FALSE) row for the SAME logical fact must be
    // rejected by fundamentals_latest_unique.
    await expect(
      pool.query(`
        INSERT INTO fundamentals
          (instrument_id, metric, observation_ts, knowledge_ts, period_type,
           value, source, content_hash, is_superseded)
        VALUES
          (1, 'net_income', 1577836800000, 1600000000000, 'duration', 120.0, 'pit-edgar', 'h3', FALSE)
      `),
    ).rejects.toThrow(/fundamentals_latest_unique/);

    // The append-only contract: fundamentals_writer holds table-level INSERT+SELECT
    // and must NOT be able to DELETE. The role is NOLOGIN, so we assert via the
    // information_schema grant catalog rather than connecting as it.
    const { rows: tablePrivs } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee='fundamentals_writer' AND table_name='fundamentals'`,
    );
    const tableGrants = tablePrivs.map((r) => r.privilege_type);
    expect(tableGrants).toContain('INSERT');
    expect(tableGrants).toContain('SELECT');
    expect(tableGrants).not.toContain('DELETE');

    // The supersede flow needs UPDATE on is_superseded ONLY — a column-level grant,
    // which surfaces in role_column_grants (not role_table_grants). Assert it is
    // scoped to exactly that column (mirror of bars_writer in 0002_bars.sql).
    const { rows: colPrivs } = await pool.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type FROM information_schema.role_column_grants
       WHERE grantee='fundamentals_writer' AND table_name='fundamentals'
         AND privilege_type='UPDATE'`,
    );
    expect(colPrivs.map((r) => r.column_name)).toEqual(['is_superseded']);

    // Clean up so the idempotency re-run test starts from an empty table.
    await pool.query("DELETE FROM fundamentals WHERE instrument_id = 1 AND metric = 'net_income'");
  }, TEST_TIMEOUT_MS);

  it('preserves every distinct raw fact (context_id + period_type are key discriminators)', async () => {
    // The raw zone is full-preservation: a filing that reports the same us-gaap tag
    // under two XBRL contexts (mapping to the same undimensioned signature) must
    // yield TWO rows, not a PK collision. context_id is part of the natural key.
    await pool.query(`
      INSERT INTO fundamentals_raw_facts
        (filing_id, raw_tag, taxonomy, context_id, period_type, period_end, knowledge_ts, value, dim_signature, content_hash)
      VALUES
        (101, 'us-gaap:Revenues', 'us-gaap', 'ctxA', 'duration', 1577836800000, 1580000000000, 100, '', 'h1'),
        (101, 'us-gaap:Revenues', 'us-gaap', 'ctxB', 'duration', 1577836800000, 1580000000000, 200, '', 'h2')
    `);
    // And an instant fact and a duration fact sharing the same period_end must not
    // collapse — period_type discriminates (instant balance-sheet vs duration flow).
    await pool.query(`
      INSERT INTO fundamentals_raw_facts
        (filing_id, raw_tag, taxonomy, context_id, period_type, period_start, period_end, knowledge_ts, value, dim_signature, content_hash)
      VALUES
        (102, 'us-gaap:SomeTag', 'us-gaap', 'i', 'instant',  NULL,          1577836800000, 1580000000000, 50, '', 'hi'),
        (102, 'us-gaap:SomeTag', 'us-gaap', 'd', 'duration', 1546300800000, 1577836800000, 1580000000000, 75, '', 'hd')
    `);
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM fundamentals_raw_facts WHERE filing_id IN (101, 102)',
    );
    expect(rows[0].n).toBe(4);

    await pool.query('DELETE FROM fundamentals_raw_facts WHERE filing_id IN (101, 102)');
  }, TEST_TIMEOUT_MS);

  it('is idempotent on re-run', async () => {
    const result = await runMigrations(sqlDir, pool);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(expectedFiles());
  }, TEST_TIMEOUT_MS);
});

// ── 0012 flag-day migration — deep-hypertable lock-table OOM regression ──────────────────────────
// The first cut of 0012 did `DROP TABLE bars CASCADE` inside the runner's single per-file
// transaction. On a FRESH container that passed; on the LIVE DB (a ~1000-chunk daily series) it
// failed `timescale-init` with "out of shared memory" / SQLSTATE 53200 (LockAcquireExtended) —
// `DROP TABLE` AccessExclusiveLocks EVERY chunk at once, overflowing the lock table (the same
// lock-fan the bars-OOM work fights). The fix: 0012 runs NON-transactionally and empties each
// hypertable via bounded-window `drop_chunks` (each its own auto-committed statement) before the
// `DROP TABLE`. This test reproduces the live precondition — a deep many-chunk `bars` under a TIGHT
// lock budget (max_locks_per_transaction=16) where the old single-txn drop MUST 53200 — and asserts
// `runMigrations` applies 0012 cleanly. The unit test only saw a fresh DB; this is the gap that let
// the OOM ship to the live deploy.
const OOM_MAX_LOCKS = 16;
const OOM_MAX_CONNECTIONS = 24;
const PRE_0012 = (): string[] => readdirSyncSorted().filter((f) => f < '0012');

function readdirSyncSorted(): string[] {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return readdirSync(path.resolve(thisDir, '..', '..', 'sql')).filter((f) => f.endsWith('.sql')).sort();
}

describe.skipIf(!dockerAvailable)('runMigrations — 0012 flag-day deep-hypertable OOM regression', () => {
  let container: StartedTestContainer;
  let pool: pg.Pool;
  let sqlDir: string;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      // Tight lock budget — locking ~1000 chunks in one plan/txn must overflow it (the OOM precondition).
      .withCommand([
        'postgres',
        '-c', 'shared_preload_libraries=timescaledb',
        '-c', `max_locks_per_transaction=${OOM_MAX_LOCKS}`,
        '-c', `max_connections=${OOM_MAX_CONNECTIONS}`,
      ])
      .start();
    pool = new pg.Pool({
      host: container.getHost(), port: container.getMappedPort(5432),
      user: 'postgres', password: 'test', database: 'trader_ts',
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb'); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    sqlDir = path.resolve(thisDir, '..', '..', 'sql');

    // Apply the OLD (pre-0012, ticker-shaped) schema by recording it in schema_migrations after
    // applying each file directly — so the runner under test only has 0012 left to apply, exactly
    // mirroring the live DB state when the timescale-init hook ran.
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const { readFile } = await import('node:fs/promises');
    for (const f of PRE_0012()) {
      const sql = await readFile(path.join(sqlDir, f), 'utf8');
      // Each old file is itself transaction-safe on a fresh DB (create-only). Apply in one txn.
      const c = await pool.connect();
      try { await c.query('BEGIN'); await c.query(sql); await c.query('COMMIT'); }
      finally { c.release(); }
      await pool.query('INSERT INTO schema_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [f]);
    }

    // Seed a DEEP daily series 2006→now (~1000+ 7-day chunks). Insert in ≤90-day batches: each batch's
    // transaction touches ~13 chunks (fits the tight budget); a single all-span insert would itself OOM.
    const startTs = Date.UTC(2006, 0, 1);
    const endTs = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const batchMs = 90 * dayMs;
    for (let lo = startTs; lo < endTs; lo += batchMs) {
      const hi = Math.min(lo + batchMs - dayMs, endTs);
      await pool.query(
        `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         SELECT 'AAPL_US_EQ', g, g, 'daily', 10, 10, 10, 10, 1000, 10, 'h' || g::text, FALSE
           FROM generate_series($1::bigint, $2::bigint, $3::bigint) AS g`,
        [lo, hi, dayMs],
      );
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  }, TEST_TIMEOUT_MS);

  it('the deep bars hypertable really spans many chunks (the OOM precondition)', async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    expect(rows[0].n).toBeGreaterThan(200);
  });

  it('a single-transaction DROP TABLE of the deep hypertable exhausts the lock table (the shipped bug)', async () => {
    // Proves the precondition is real: the OLD 0012 shape (drop in one txn) MUST 53200 here. If this
    // ever stops erroring, the non-transactional fix's necessity should be re-checked.
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await expect(c.query('DROP TABLE bars CASCADE')).rejects.toMatchObject({ code: '53200' });
    } finally {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      c.release();
    }
  }, TEST_TIMEOUT_MS);

  it('runMigrations applies 0012 on the deep hypertable WITHOUT exhausting the lock table', async () => {
    const result = await runMigrations(sqlDir, pool);
    expect(result.applied).toEqual(['0012_bars_symbol_market.sql']);

    // The tables were recreated new-shape: symbol+market, no ticker, and emptied of the deep series.
    const { rows: cols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'bars'`,
    );
    const names = cols.map((r) => r.column_name);
    expect(names).toContain('symbol');
    expect(names).toContain('market');
    expect(names).not.toContain('ticker');
    const { rows: cnt } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM bars`);
    expect(cnt[0].n).toBe(0);
    // The re-keyed indexes + compression are in place.
    const { rows: idx } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'bars'`,
    );
    expect(idx.map((r) => r.indexname)).toContain('bars_asof_lookup');
  }, TEST_TIMEOUT_MS);

  it('is idempotent — a second runMigrations skips 0012', async () => {
    const result = await runMigrations(sqlDir, pool);
    expect(result.applied).toEqual([]);
    expect(result.skipped).toContain('0012_bars_symbol_market.sql');
  }, TEST_TIMEOUT_MS);
});

async function isDockerAvailable(): Promise<boolean> {
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
}
