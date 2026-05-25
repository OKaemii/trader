// Tests for writeBarRevisionsPg — the Timescale twin of persist-bars.test.ts.
//
// Coverage matches the Mongo writer's test file 1:1:
//   • First insert (no prior row): one new row + audit row with prior_hash:null
//   • Idempotent re-poll (identical hash): zero writes, zero audit rows
//   • Revision (differing content): atomic supersede + insert + audit
//   • Mixed batch: stats account for skips + first-prints + revisions
//   • Defensive: empty input, non-finite observation_ts
//
// Unlike the Mongo test (which mocks the collection layer), this is a real
// integration test against a testcontainers Timescale. The Postgres-side SQL
// (unnest lookup, supersede UPDATE, partial-unique index) is non-trivial enough
// that mocking away the DB defeats the test's purpose.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { hashBarContent } from '@trader/shared-bars';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OHLCVBar } from '@trader/shared-types';
import {
  writeBarRevisionsPg,
  fetchFirstPrintClosesPg,
} from '../modules/bars/infrastructure/pg-bar-writer.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 120_000;

function bar(ticker: string, obs: number, close: number, overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    ticker,
    observation_ts: obs,
    timestamp:      obs,
    interval:       '5m',
    open:  close, high: close + 0.5, low: close - 0.5, close,
    volume: 1_000,
    ...overrides,
  };
}

describe.skipIf(!dockerAvailable)('writeBarRevisionsPg', () => {
  let container: StartedTestContainer;

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

    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;

    // Wait for the extension to be createable, then run migrations.
    const pool = getPgPool();
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlDir = path.resolve(thisDir, '..', '..', '..', '..', 'packages', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    // Truncate the data tables between tests — preserves the schema + the
    // schema_migrations rows so we don't re-apply migrations every test.
    const pool = getPgPool();
    await pool.query('TRUNCATE bars, bar_revisions_log');
  });

  describe('first insert (no prior row)', () => {
    it('inserts the row with knowledge_ts + is_superseded=false and writes an audit entry with prior_hash=null', async () => {
      const now = 1_700_000_000_000;
      const b = bar('A', 1_000, 100);

      const stats = await writeBarRevisionsPg([b], '5m', now);
      expect(stats).toEqual({ attempted: 1, inserted: 1, revisions: 0, skipped: 0 });

      const pool = getPgPool();
      const { rows: barsRows } = await pool.query(
        'SELECT ticker, observation_ts, knowledge_ts, interval, close, content_hash, is_superseded FROM bars',
      );
      expect(barsRows).toHaveLength(1);
      expect(barsRows[0]).toMatchObject({
        ticker: 'A',
        observation_ts: '1000',
        knowledge_ts: String(now),
        interval: '5m',
        is_superseded: false,
      });
      expect(Number(barsRows[0].close)).toBe(100);
      expect(barsRows[0].content_hash).toBe(hashBarContent(b));

      const { rows: auditRows } = await pool.query(
        'SELECT ticker, observation_ts, prior_hash, new_hash FROM bar_revisions_log',
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        ticker: 'A',
        observation_ts: '1000',
        prior_hash: null,
        new_hash: hashBarContent(b),
      });
    });
  });

  describe('idempotent re-poll', () => {
    it('skips bars whose content_hash matches the latest stored revision', async () => {
      const b = bar('A', 1_000, 100);
      await writeBarRevisionsPg([b], '5m', 1_700_000_000_000);

      const stats = await writeBarRevisionsPg([b], '5m', 1_700_000_001_000);

      expect(stats).toEqual({ attempted: 1, inserted: 0, revisions: 0, skipped: 1 });

      const pool = getPgPool();
      const { rows: barsRows } = await pool.query('SELECT count(*)::int AS n FROM bars');
      expect(barsRows[0]?.n).toBe(1); // No second row inserted.
      const { rows: auditRows } = await pool.query('SELECT count(*)::int AS n FROM bar_revisions_log');
      expect(auditRows[0]?.n).toBe(1); // No second audit row.
    });

    it('skips multiple identical bars in one batch', async () => {
      const b1 = bar('A', 1_000, 100);
      const b2 = bar('A', 2_000, 200);
      await writeBarRevisionsPg([b1, b2], '5m');

      const stats = await writeBarRevisionsPg([b1, b2], '5m');
      expect(stats.skipped).toBe(2);
      expect(stats.inserted).toBe(0);
    });
  });

  describe('revision', () => {
    it('flips is_superseded=true on the prior row, inserts the new row, audits with prior_hash set', async () => {
      const original = bar('A', 1_000, 100);
      const revised  = bar('A', 1_000, 101);
      const priorHash = hashBarContent(original);
      const newHash   = hashBarContent(revised);
      expect(priorHash).not.toBe(newHash);

      const t0 = 1_700_000_000_000;
      const t1 = 1_700_000_001_000;
      await writeBarRevisionsPg([original], '5m', t0);
      const stats = await writeBarRevisionsPg([revised], '5m', t1);
      expect(stats).toEqual({ attempted: 1, inserted: 1, revisions: 1, skipped: 0 });

      const pool = getPgPool();
      const { rows: barsRows } = await pool.query(
        `SELECT knowledge_ts, close, content_hash, is_superseded
           FROM bars
          WHERE ticker='A' AND observation_ts=1000 AND interval='5m'
          ORDER BY knowledge_ts ASC`,
      );
      expect(barsRows).toHaveLength(2);
      // Prior row flipped, new row latest.
      expect(barsRows[0]).toMatchObject({ knowledge_ts: String(t0), is_superseded: true,  content_hash: priorHash });
      expect(barsRows[1]).toMatchObject({ knowledge_ts: String(t1), is_superseded: false, content_hash: newHash   });
      expect(Number(barsRows[1].close)).toBe(101);

      // Partial-unique index must permit this — one is_superseded=false row per (ticker, observation_ts, interval).
      const { rows: latest } = await pool.query(
        `SELECT count(*)::int AS n FROM bars WHERE is_superseded = FALSE AND ticker='A' AND observation_ts=1000`,
      );
      expect(latest[0]?.n).toBe(1);

      // Audit log: latest entry diffs the two hashes.
      const { rows: auditRows } = await pool.query(
        `SELECT prior_hash, new_hash FROM bar_revisions_log
          WHERE ticker='A' AND observation_ts=1000
          ORDER BY knowledge_ts ASC`,
      );
      expect(auditRows).toHaveLength(2);
      expect(auditRows[0]).toMatchObject({ prior_hash: null,      new_hash: priorHash });
      expect(auditRows[1]).toMatchObject({ prior_hash: priorHash, new_hash: newHash   });
    });
  });

  describe('mixed batch', () => {
    it('correctly accounts skips, first-prints, and revisions in stats', async () => {
      const skipBar    = bar('A', 1_000, 100);
      const newBar     = bar('A', 2_000, 200);
      const oldB       = bar('B', 1_000, 49);
      const reviseBar  = bar('B', 1_000, 50);

      // Seed: skipBar already present at A|1000; oldB already present at B|1000.
      await writeBarRevisionsPg([skipBar, oldB], '5m');

      const stats = await writeBarRevisionsPg([skipBar, newBar, reviseBar], '5m');
      expect(stats.attempted).toBe(3);
      expect(stats.skipped).toBe(1);
      expect(stats.inserted).toBe(2);
      expect(stats.revisions).toBe(1);

      const pool = getPgPool();
      // Final state: 4 rows total (skipBar, newBar, oldB(superseded), reviseBar).
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM bars');
      expect(rows[0]?.n).toBe(4);

      // Two latest rows for B's observation: the supersede transition + reviseBar.
      const { rows: bLatest } = await pool.query(
        `SELECT count(*)::int AS n FROM bars
          WHERE ticker='B' AND observation_ts=1000 AND is_superseded=FALSE`,
      );
      expect(bLatest[0]?.n).toBe(1);
    });
  });

  describe('defensive guards', () => {
    it('returns zero-stats for empty input', async () => {
      const stats = await writeBarRevisionsPg([], '5m');
      expect(stats).toEqual({ attempted: 0, inserted: 0, revisions: 0, skipped: 0 });
    });

    it('drops bars with non-finite observation_ts', async () => {
      const bad = { ...bar('A', 1_000, 100), observation_ts: Number.NaN };
      const stats = await writeBarRevisionsPg([bad as OHLCVBar], '5m');
      // Same shape as the Mongo writer: counted as attempted, then filtered out so
      // inserted/skipped stay zero.
      expect(stats.attempted).toBe(1);
      expect(stats.inserted).toBe(0);
      expect(stats.skipped).toBe(0);

      const pool = getPgPool();
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM bars');
      expect(rows[0]?.n).toBe(0);
    });
  });

  describe('fetchFirstPrintClosesPg', () => {
    it('returns the smallest-knowledge_ts close per (ticker, observation_ts) — distinguishing first-prints from revisions', async () => {
      const original = bar('A', 1_000, 100);
      const revised  = bar('A', 1_000, 101);
      await writeBarRevisionsPg([original], '5m', 1_700_000_000_000);
      await writeBarRevisionsPg([revised],  '5m', 1_700_000_001_000);

      const map = await fetchFirstPrintClosesPg([revised], '5m');
      // First-print close was 100 (original), not 101 (the revision).
      expect(map.get('A|1000')).toBe(100);
    });

    it('omits keys with no prior row (first-prints — caller treats absence as the marker)', async () => {
      const map = await fetchFirstPrintClosesPg([bar('A', 1_000, 100)], '5m');
      expect(map.has('A|1000')).toBe(false);
    });
  });
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
