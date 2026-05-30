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

    // Both append-only roles exist.
    const { rows: roles } = await pool.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname IN ('audit_writer','bars_writer')",
    );
    expect(roles.length).toBe(2);
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
