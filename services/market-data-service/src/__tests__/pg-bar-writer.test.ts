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
import { hashBarContent, getDailyDepthPg } from '@trader/shared-bars';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OHLCVBar } from '@trader/shared-types';
import {
  writeBarRevisionsPg,
  fetchFirstPrintClosesPg,
  WRITE_BATCH_SIZE,
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

// The write-path twin of the getBarAtOrBefore many-chunk OOM regression (epic
// pit-coverage-completeness §C1; at-or-before.test.ts). The capstone deep backfill
// (~7545 daily bars/name spanning 2006→now, 7-day chunks ≈ 1000+ chunks) handed
// writeBarRevisionsPg the whole series as ONE array. Its per-call "latest revision"
// lookup — `(ticker, observation_ts) IN (SELECT unnest(...))` with keys spanning the
// entire 2006→now range — cannot be chunk-pruned (the IN-list is opaque to the planner),
// so the read opens an index scan and takes a lock on every chunk; the shared lock table
// overflows → "out of shared memory" (lock.c LockAcquireExtended, SQLSTATE 53200). The
// DUAL_WRITE Timescale write then failed while the Mongo write succeeded, so the deep
// series landed in Mongo but NOT the BARS_BACKEND=timescale read store (daily-depth showed
// only ~5y, oldest 2021-06-02).
//
// As in the read-path test, we shrink BOTH max_locks_per_transaction and max_connections
// (16 × 10) so ~1000 chunk locks overflow the table deterministically. The OLD unbounded
// lookup query MUST error 53200; the NEW WRITE_BATCH_SIZE-bounded + literal-time-bounded
// writeBarRevisionsPg MUST land the whole 2006→now series (queryable via getDailyDepthPg).
// (Verified: removing the sort/batch + literal lower/upper bound makes the lookup OOM
// reappear inside writeBarRevisionsPg itself.)
//
// NOTE the supersede correctness test lives in its own DEFAULT-lock-budget block below: a
// hypertable UPDATE inherently locks every chunk at PLAN time (TimescaleDB can't
// chunk-exclude DML), so a single deep-history revision needs ~chunk-count lock slots — a
// bounded set that fits production's lock table but NOT this artificially tiny one. The
// tight budget here isolates the BULK-WRITE lookup lock-fan, which is the production bug;
// revisions are bounded-per-row and rare on a deep series.
const OOM_MAX_LOCKS = 16;
const OOM_MAX_CONNECTIONS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const START_2006 = Date.UTC(2006, 0, 3);

// The deep daily series the capstone backfill produces: one bar/day 2006→now ⇒ ~7500
// bars across ~1000+ 7-day chunks.
function deepDailySeries(ticker: string, close = 10): OHLCVBar[] {
  const out: OHLCVBar[] = [];
  const end = Date.now();
  for (let ts = START_2006; ts < end; ts += DAY_MS) {
    out.push(bar(ticker, ts, close, { interval: 'daily', timestamp: ts }));
  }
  return out;
}

describe.skipIf(!dockerAvailable)('writeBarRevisionsPg — bulk-write lock-table OOM regression (tight lock budget)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      // Small shared lock table — locking ~1000 chunks in one plan must overflow it.
      .withCommand([
        'postgres',
        '-c', 'shared_preload_libraries=timescaledb',
        '-c', `max_locks_per_transaction=${OOM_MAX_LOCKS}`,
        '-c', `max_connections=${OOM_MAX_CONNECTIONS}`,
      ])
      .start();
    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;
    const pool = getPgPool();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb'); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlDir = path.resolve(thisDir, '..', '..', '..', '..', 'packages', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  // NOTE: no per-test TRUNCATE here. On a deep hypertable TRUNCATE itself takes a lock on
  // every chunk — under this test's tiny lock budget (16) that overflows the lock table
  // (the very failure mode under test). Each test uses a DISTINCT ticker instead, so they
  // never collide despite sharing the container.

  it('the NEW batched write lands the whole 2006→now series without exhausting the lock table', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const series = deepDailySeries('NEW');
    // The series must be deep enough to span > the lock budget in chunks (~1000), so a
    // single unbounded lookup over it would OOM.
    expect(series.length).toBeGreaterThan(WRITE_BATCH_SIZE * 4);

    // The fix: writeBarRevisionsPg sorts + batches + literal-time-bounds each lookup, so
    // this deep write SUCCEEDS where the single-array path 53200'd in production.
    const stats = await writeBarRevisionsPg(series, 'daily');
    expect(stats.inserted).toBe(series.length);
    expect(stats.skipped).toBe(0);
    expect(stats.revisions).toBe(0); // all first-prints

    // The hypertable really spans many chunks — the OOM precondition.
    const pool = getPgPool();
    const { rows: chunkRows } = await pool.query(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    expect(chunkRows[0].n).toBeGreaterThan(200);

    // All rows landed and reach 2006 — the deep series is now in the timescale read store,
    // not just Mongo. getDailyDepthPg is itself bounded (it walked the deep table without OOM).
    const depth = await getDailyDepthPg('NEW', 'daily');
    expect(depth.count).toBe(series.length);
    expect(depth.oldest).toBe(START_2006);
  }, TEST_TIMEOUT_MS);

  it('an idempotent re-write of the deep series skips every bar without exhausting the lock table', async () => {
    process.env.BARS_BACKEND = 'timescale';
    // Re-running the same deep backfill (the operator re-runs it after deploy) must hit the
    // bounded lookup on EVERY batch (it reads each batch's existing rows to compare hashes) —
    // the exact path the OOM lived on — and skip all bars. This is the re-backfill the
    // capstone runs once this fix deploys.
    const series = deepDailySeries('REPEAT');
    await writeBarRevisionsPg(series, 'daily');
    const stats = await writeBarRevisionsPg(series, 'daily');
    expect(stats.skipped).toBe(series.length);
    expect(stats.inserted).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('the OLD single-array lookup shape exhausts the lock table (reproduces the production 53200)', async () => {
    process.env.BARS_BACKEND = 'timescale';
    // Populate the deep series via the (fixed) batched writer so the hypertable holds the
    // ~1000 chunks the OOM needs.
    const series = deepDailySeries('OLD');
    await writeBarRevisionsPg(series, 'daily');

    const pool = getPgPool();
    const tickers   = series.map((b) => b.ticker);
    const obsTsList = series.map((b) => b.observation_ts);
    // The exact unbounded lookup writeBarRevisionsPg ran before this fix when handed the
    // whole series in one shot: an IN-list of keys straddling 2006→now with NO time bound.
    // Its plan locks every chunk before it can resolve → "out of shared memory" (SQLSTATE
    // 53200). This is the assertion the original writer test never made — the gap that let
    // the OOM ship.
    await expect(
      pool.query(
        `SELECT ticker, observation_ts, content_hash
           FROM bars
          WHERE interval = $1
            AND is_superseded = FALSE
            AND (ticker, observation_ts) IN (
              SELECT unnest($2::text[]), unnest($3::bigint[])
            )`,
        ['daily', tickers, obsTsList],
      ),
    ).rejects.toMatchObject({ code: '53200' }); // 53200 = out_of_memory (shared lock table)
  }, TEST_TIMEOUT_MS);
});

describe.skipIf(!dockerAvailable)('writeBarRevisionsPg — deep-series bi-temporal supersede (default lock budget)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    // DEFAULT lock budget (no max_locks_per_transaction override): a hypertable UPDATE
    // locks every chunk at plan time, so a deep-history revision needs ~chunk-count slots —
    // fine under the default ~6400-slot table (production), impossible under the tight
    // budget the bulk-write block uses. This block proves the batching fix keeps the
    // supersede semantics correct on a deep, multi-chunk series.
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      .withCommand(['postgres', '-c', 'shared_preload_libraries=timescaledb'])
      .start();
    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;
    const pool = getPgPool();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await pool.query('CREATE EXTENSION IF NOT EXISTS timescaledb'); break; }
      catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const sqlDir = path.resolve(thisDir, '..', '..', '..', '..', 'packages', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  it('a revision deep in a multi-chunk series flips the prior row and keeps depth at 2006', async () => {
    process.env.BARS_BACKEND = 'timescale';
    // Deep first-print series, then revise ONE deep-history bar (close 10 → 11). The supersede
    // must stay atomic within its batch's per-bar transaction even though the bar sits deep in
    // a multi-chunk series, and the prior first-print is flipped (not overwritten).
    const series = deepDailySeries('REV', 10);
    const seedStats = await writeBarRevisionsPg(series, 'daily', 1_700_000_000_000);
    expect(seedStats.inserted).toBe(series.length);

    const reviseTs = START_2006 + 50 * DAY_MS; // a 2006 observation, deep in the series
    const revised = bar('REV', reviseTs, 11, { interval: 'daily', timestamp: reviseTs });
    const stats = await writeBarRevisionsPg([revised], 'daily', 1_700_000_001_000);
    expect(stats.inserted).toBe(1);
    expect(stats.revisions).toBe(1);

    const pool = getPgPool();
    // Exactly one live row at that observation, and it's the revision (close 11).
    const { rows: live } = await pool.query(
      `SELECT close, is_superseded FROM bars
        WHERE ticker='REV' AND observation_ts=$1 AND interval='daily' AND is_superseded=FALSE`,
      [reviseTs],
    );
    expect(live).toHaveLength(1);
    expect(Number(live[0].close)).toBe(11);
    // The prior first-print row is flipped superseded (still present — bi-temporal, never overwritten).
    const { rows: all } = await pool.query(
      `SELECT close, is_superseded FROM bars
        WHERE ticker='REV' AND observation_ts=$1 AND interval='daily' ORDER BY knowledge_ts ASC`,
      [reviseTs],
    );
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ is_superseded: true });
    expect(Number(all[0].close)).toBe(10);
    expect(all[1]).toMatchObject({ is_superseded: false });
    expect(Number(all[1].close)).toBe(11);
    // Depth still reaches 2006 and the live count is unchanged (one live row per observation).
    const depth = await getDailyDepthPg('REV', 'daily');
    expect(depth.oldest).toBe(START_2006);
    expect(depth.count).toBe(series.length);
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
