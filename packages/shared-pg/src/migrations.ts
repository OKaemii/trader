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
    // A migration may opt OUT of the wrapping transaction with a `-- shared-pg:no-transaction`
    // directive on its first non-blank line. Required for files that cannot run inside one
    // transaction — e.g. a flag-day drop-and-recreate of a DEEP hypertable: `DROP TABLE` (or a
    // single all-chunk `drop_chunks`) takes an AccessExclusiveLock on EVERY chunk at once, and a
    // ~1000-chunk `bars` series overflows the shared lock table inside one txn → "out of shared
    // memory" / 53200 (the same lock-fan the bars OOM work fights). In no-transaction mode the
    // statements run via the simple-query protocol with NO explicit BEGIN, so each statement
    // (each bounded-window `drop_chunks`, the final `DROP TABLE`, each `CREATE`) commits and
    // releases its locks before the next — never holding the whole hypertable's locks at once.
    // The trade-off is atomicity: a no-transaction migration that fails partway leaves the DB in
    // an intermediate state. It must therefore be written idempotently (IF EXISTS / IF NOT EXISTS /
    // if_not_exists) so a re-run completes it; schema_migrations only records it on full success.
    const noTransaction = /^\s*--\s*shared-pg:no-transaction\b/m.test(sql.split('\n').find((l) => l.trim() !== '') ?? '');
    const client = await usePool.connect();
    try {
      if (noTransaction) {
        // No wrapping BEGIN. CRUCIAL: a multi-statement string sent in ONE simple-Query message is
        // wrapped by the server in a single implicit transaction (so its locks would NOT release
        // between statements — re-introducing the lock fan). So we split the file into individual
        // statements and send each as its OWN query: each is then its own implicit transaction that
        // commits and releases its locks before the next. The schema_migrations insert follows.
        for (const stmt of splitSqlStatements(sql)) {
          await client.query(stmt);
        }
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      } else {
        // One transaction per file. If a migration spans multiple DDL statements
        // (it does — bars.sql creates a table, a hypertable, two indexes, a
        // compression policy, two roles), the whole file is applied atomically.
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      }
      applied.push(file);
    } catch (err) {
      if (!noTransaction) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
      }
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

/**
 * Split a SQL file into individual statements on top-level semicolons, ignoring semicolons inside
 * dollar-quoted blocks (`$$ … $$` / `$tag$ … $tag$`), single-quoted string literals, and `--` line
 * comments. Used ONLY by the no-transaction migration path (so each statement runs as its own
 * implicit transaction). The migration SQL here is hand-written + trusted (never user input), so this
 * is a pragmatic tokenizer, not a full SQL parser: it handles the constructs our migrations actually
 * use (DO $$ … $$ blocks, bigint literals, comments) and is unit-tested against 0012's shape.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // Line comment: skip to end of line (keep it in buf so error messages stay readable).
    if (ch === '-' && sql[i + 1] === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // Single-quoted string literal: copy verbatim through the closing quote ('' is an escaped quote).
    if (ch === "'") {
      buf += ch; i++;
      while (i < n) {
        buf += sql[i];
        if (sql[i] === "'") { if (sql[i + 1] === "'") { buf += sql[i + 1]; i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    // Dollar-quoted block ($$ or $tag$): copy verbatim through the matching closing tag.
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, end);
        i = end;
        continue;
      }
    }
    // Top-level statement terminator.
    if (ch === ';') {
      const trimmed = buf.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  // Trailing statement without a terminating semicolon, ignoring a comment-only / whitespace tail.
  const tail = buf.trim();
  if (tail.length > 0 && !/^(--[^\n]*\n?\s*)*$/.test(tail)) statements.push(tail);
  return statements;
}

function defaultSqlDir(): string {
  // import.meta.url points at the compiled migrations.js at runtime
  // (dist/migrations.js). SQL files ship alongside in the package root (`sql/`).
  // In the source tree the same relative path (../sql) resolves correctly.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(thisDir, '..', 'sql');
}
