// SQL-file migration runner. Reads `<sqlDir>/*.sql` in lexical order, applies each
// inside its own transaction, and records the filename in `schema_migrations`. Re-runs
// are no-ops: any file already present in that table is skipped without parsing.
//
// Why this and not a node-pg-migrate-style library: the migration set here is small
// (< 10 files), all forward-only, all bootstrap-shaped (hypertable creation, role
// grants, compression policies). A 40-line script that we own is easier to audit than
// pulling in a transitive dependency for the same behaviour.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { getPgPool } from './client.ts';

const ENSURE_SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every `*.sql` file in `sqlDir` that isn't yet recorded in `schema_migrations`.
 *
 * @param sqlDir  Absolute path to a directory containing migration SQL files.
 *                Defaults to the `sql/` directory shipped with `@trader/shared-pg`.
 * @param pool    Optional pre-built pool; lets tests inject a testcontainer pool
 *                without going through `getPgPool` (which reads `TIMESCALE_URL`).
 */
export async function runMigrations(
  sqlDir?: string,
  pool?: pg.Pool,
): Promise<RunMigrationsResult> {
  const resolvedDir = sqlDir ?? defaultSqlDir();
  const usePool = pool ?? getPgPool();

  await usePool.query(ENSURE_SCHEMA_MIGRATIONS_SQL);

  const entries = await readdir(resolvedDir);
  const sqlFiles = entries.filter((f) => f.endsWith('.sql')).sort();

  const { rows: appliedRows } = await usePool.query<{ name: string }>(
    'SELECT name FROM schema_migrations',
  );
  const alreadyApplied = new Set(appliedRows.map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of sqlFiles) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(resolvedDir, file), 'utf8');
    const client = await usePool.connect();
    try {
      // One transaction per file. If a migration spans multiple DDL statements
      // (it does — bars.sql creates a table, a hypertable, two indexes, a
      // compression policy, two roles), the whole file is applied atomically.
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name) VALUES ($1)',
        [file],
      );
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      throw new Error(
        `[shared-pg] migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

function defaultSqlDir(): string {
  // import.meta.url points at the compiled migrations.js at runtime
  // (dist/migrations.js). SQL files ship alongside in the package root (`sql/`).
  // In the source tree the same relative path (../sql) resolves correctly.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '..', 'sql');
}
