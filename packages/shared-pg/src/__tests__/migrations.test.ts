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
import { runMigrations } from '../migrations.ts';

const dockerAvailable = await isDockerAvailable();

const TEST_TIMEOUT_MS = 120_000;

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

async function isDockerAvailable(): Promise<boolean> {
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
}
