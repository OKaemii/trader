// Tests for the BARS_BACKEND-dispatched coverage / gap-detection reads:
//   • getObservedTimestamps        — the windowed observed-ts read behind planGapWindows
//   • countBarsForTickers          — set-scoped unsuperseded bar count (bootstrap coverage checks)
//   • countAllBars                 — whole-store unsuperseded bar count (admin /coverage)
//   • latestObservationForTickers  — set-scoped latest unsuperseded obs (self-heal gap detect)
//   • countRevisionsForTickers     — whole-store genuine-revision count (admin /coverage revisions)
//   • getRevisionsForTicker        — per-ticker revision trail (admin /revisions/:ticker)
//
// These are the maintenance reads that the writer-flip card moves onto the dispatcher so they read
// the SAME store the writer writes to. The load-bearing guarantees pinned here:
//   • Mongo↔pg PARITY — the same fixture set returns the same counts / timestamps / rows from both
//     backends, so flipping BARS_BACKEND is read-side indistinguishable for gap detection.
//   • Bounded reads — count/latest carry a `sinceMs` floor so on a deep hypertable they prune to the
//     window's chunks; an UNBOUNDED whole-store aggregate over the same series MUST OOM (the lock-fan
//     the bars-OOM work fights). Proven against a real TimescaleDB testcontainer with a tight budget.
//   • Dispatcher — routes mongo vs timescale by BARS_BACKEND; db=undefined on the mongo default throws.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import type { TickerIdentity } from '@trader/ticker-identity';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getObservedTimestamps, countBarsForTickers, countAllBars,
  latestObservationForTickers, countRevisionsForTickers, getRevisionsForTicker,
} from '../index.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 120_000;
const day = 24 * 60 * 60 * 1000;

const AAPL: TickerIdentity = { symbol: 'AAPL', market: 'US' };
const MSFT: TickerIdentity = { symbol: 'MSFT', market: 'US' };
const SHEL: TickerIdentity = { symbol: 'SHEL', market: 'LSE' };

const _now = Date.now();
const utcMidnight = Date.parse(`${new Date(_now).toISOString().slice(0, 10)}T00:00:00.000Z`);

// ── In-memory Mongo stub (mongo branch) ─────────────────────────────────────────────────────────
// Enough of find()/aggregate() to exercise the dispatched reads' Mongo branches: the windowed
// observed-ts find (getObservedTimestamps), the $group counts (countBars*, latest*), and the
// bar_revisions_log find/aggregate. The pipeline shapes are narrow + fixed, so we interpret them.
function makeBarsDoc(symbol: string, market: string, obsTs: number, opts: { superseded?: boolean; interval?: string } = {}) {
  return {
    symbol, market, observation_ts: obsTs, knowledge_ts: obsTs, interval: opts.interval ?? '5m',
    is_superseded: opts.superseded ?? false, open: 1, high: 1, low: 1, close: 1, volume: 1,
  };
}
function makeRevDoc(symbol: string, market: string, obsTs: number, knowledgeTs: number, priorHash: string | null) {
  return { symbol, market, observation_ts: obsTs, interval: '5m', knowledge_ts: knowledgeTs, prior_hash: priorHash, new_hash: 'h' };
}

// Minimal matcher: top-level equality, $gte/$lte/$gt on a numeric field, $ne, and the $or membership.
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$or') {
      const clauses = v as Array<Record<string, unknown>>;
      if (!clauses.some((c) => matchFilter(doc, c))) return false;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ('$gte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >= (ops.$gte as number))) return false;
      if ('$lte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) <= (ops.$lte as number))) return false;
      if ('$gt'  in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >  (ops.$gt  as number))) return false;
      if ('$ne'  in ops && doc[k] === ops.$ne) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

// Interpret the small set of aggregation pipelines the dispatched reads build.
function runAggregate(docs: Array<Record<string, unknown>>, pipeline: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  let rows = docs.slice();
  const matchStage = pipeline.find((s) => '$match' in s)?.$match as Record<string, unknown> | undefined;
  if (matchStage) rows = rows.filter((d) => matchFilter(d, matchStage));
  const groupStage = pipeline.find((s) => '$group' in s)?.$group as Record<string, unknown> | undefined;
  if (!groupStage) return rows;
  // _id is { symbol: '$symbol', market: '$market' }; accumulator is count $sum:1, revisions $sum:1, or latest $max:'$observation_ts'.
  const byKey = new Map<string, { _id: { symbol: string; market: string }; count: number; revisions: number; latest: number }>();
  for (const d of rows) {
    const key = `${d.symbol}|${d.market}`;
    let acc = byKey.get(key);
    if (!acc) { acc = { _id: { symbol: String(d.symbol), market: String(d.market) }, count: 0, revisions: 0, latest: -Infinity }; byKey.set(key, acc); }
    acc.count += 1;
    acc.revisions += 1;
    acc.latest = Math.max(acc.latest, Number(d.observation_ts));
  }
  return [...byKey.values()];
}

function makeDb(bars: Array<Record<string, unknown>>, revs: Array<Record<string, unknown>> = []) {
  const collFor = (docs: Array<Record<string, unknown>>) => ({
    find: (filter: Record<string, unknown>) => {
      let matched = docs.filter((d) => matchFilter(d, filter));
      const cursor = {
        project: () => cursor,
        sort: (spec: Record<string, number>) => {
          const [k, dir] = Object.entries(spec)[0]!;
          matched = matched.slice().sort((a, b) => ((a[k] as number) > (b[k] as number) ? 1 : -1) * dir);
          return cursor;
        },
        limit: (n: number) => { matched = matched.slice(0, n); return cursor; },
        toArray: async () => matched,
      };
      return cursor;
    },
    aggregate: (pipeline: Array<Record<string, unknown>>) => ({ toArray: async () => runAggregate(docs, pipeline) }),
  });
  return {
    collection: (name: string) => name === 'bar_revisions_log' ? collFor(revs) : collFor(bars),
  } as never;
}

// ── Mongo branch (no Docker) ────────────────────────────────────────────────────────────────────
describe('dispatched coverage reads — Mongo branch', () => {
  afterEach(() => { delete process.env.BARS_BACKEND; });

  it('getObservedTimestamps returns the in-window unsuperseded observation_ts for one ticker', async () => {
    delete process.env.BARS_BACKEND;
    const bars = [
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 10 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight - 5 * 60_000),                         // before window
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000, { superseded: true }),   // superseded
      makeBarsDoc('MSFT', 'US', utcMidnight + 5 * 60_000),                         // wrong ticker
    ];
    const ts = await getObservedTimestamps(makeDb(bars), 'AAPL_US_EQ', '5m', utcMidnight, utcMidnight + day);
    expect(ts.sort()).toEqual([utcMidnight + 5 * 60_000, utcMidnight + 10 * 60_000]);
  });

  it('countBarsForTickers counts unsuperseded bars per identity within the window', async () => {
    delete process.env.BARS_BACKEND;
    const bars = [
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 10 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000, { superseded: true }),   // excluded
      makeBarsDoc('SHEL', 'LSE', utcMidnight + 6 * 60_000),
      makeBarsDoc('TSLA', 'US', utcMidnight + 5 * 60_000),                         // not requested
    ];
    const counts = await countBarsForTickers(makeDb(bars), [AAPL, SHEL], '5m', utcMidnight - day);
    expect(counts.get('AAPL|US')).toBe(2);
    expect(counts.get('SHEL|LSE')).toBe(1);
    expect(counts.has('TSLA|US')).toBe(false);
  });

  it('countAllBars counts unsuperseded bars per identity across the whole store', async () => {
    delete process.env.BARS_BACKEND;
    const bars = [
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('MSFT', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('MSFT', 'US', utcMidnight + 10 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000, { interval: 'daily' }),  // wrong interval
    ];
    const counts = await countAllBars(makeDb(bars), '5m', utcMidnight - day);
    expect(counts.get('AAPL|US')).toBe(1);
    expect(counts.get('MSFT|US')).toBe(2);
  });

  it('latestObservationForTickers returns the max unsuperseded observation_ts per identity', async () => {
    delete process.env.BARS_BACKEND;
    const bars = [
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 30 * 60_000),
      makeBarsDoc('MSFT', 'US', utcMidnight + 7 * 60_000),
    ];
    const latest = await latestObservationForTickers(makeDb(bars), [AAPL, MSFT], '5m', utcMidnight - day);
    expect(latest.get('AAPL|US')).toBe(utcMidnight + 30 * 60_000);
    expect(latest.get('MSFT|US')).toBe(utcMidnight + 7 * 60_000);
  });

  it('countRevisionsForTickers counts only genuine revisions (prior_hash != null)', async () => {
    delete process.env.BARS_BACKEND;
    const revs = [
      makeRevDoc('AAPL', 'US', utcMidnight, utcMidnight + 1, null),                // first-print — excluded
      makeRevDoc('AAPL', 'US', utcMidnight, utcMidnight + 2, 'prev'),              // revision
      makeRevDoc('AAPL', 'US', utcMidnight, utcMidnight + 3, 'prev2'),             // revision
      makeRevDoc('MSFT', 'US', utcMidnight, utcMidnight + 1, 'prev'),              // revision
    ];
    const counts = await countRevisionsForTickers(makeDb([], revs), '5m');
    expect(counts.get('AAPL|US')).toBe(2);
    expect(counts.get('MSFT|US')).toBe(1);
  });

  it('getRevisionsForTicker returns the per-ticker trail newest-first since the cutoff', async () => {
    delete process.env.BARS_BACKEND;
    const revs = [
      makeRevDoc('AAPL', 'US', utcMidnight, 100, null),
      makeRevDoc('AAPL', 'US', utcMidnight, 200, 'h1'),
      makeRevDoc('AAPL', 'US', utcMidnight, 50, 'h0'),                             // before cutoff
      makeRevDoc('MSFT', 'US', utcMidnight, 300, 'h2'),                            // wrong ticker
    ];
    const rows = await getRevisionsForTicker(makeDb([], revs), 'AAPL', 'US', 100, 50);
    expect(rows.map((r) => r.knowledge_ts)).toEqual([200, 100]);  // newest-first, cutoff applied
    expect(rows.every((r) => r.symbol === 'AAPL')).toBe(true);
  });

  it('the set/identity reads throw when db is undefined on the mongo default', async () => {
    delete process.env.BARS_BACKEND;
    await expect(countBarsForTickers(undefined, [AAPL], '5m', 0)).rejects.toThrow(/db parameter required/);
    await expect(latestObservationForTickers(undefined, [AAPL], '5m', 0)).rejects.toThrow(/db parameter required/);
    await expect(countAllBars(undefined, '5m', 0)).rejects.toThrow(/db parameter required/);
    await expect(getObservedTimestamps(undefined, 'AAPL_US_EQ', '5m', 0, 1)).rejects.toThrow(/db parameter required/);
    await expect(countRevisionsForTickers(undefined, '5m')).rejects.toThrow(/db parameter required/);
    await expect(getRevisionsForTicker(undefined, 'AAPL', 'US', 0, 10)).rejects.toThrow(/db parameter required/);
  });

  it('empty id set short-circuits to an empty Map with no query', async () => {
    delete process.env.BARS_BACKEND;
    expect((await countBarsForTickers(undefined, [], '5m', 0)).size).toBe(0);
    expect((await latestObservationForTickers(undefined, [], '5m', 0)).size).toBe(0);
  });
});

// ── Real Postgres parity + the bounded-read regression (Docker-gated) ──────────────────────────────
describe.skipIf(!dockerAvailable)('dispatched coverage reads — Mongo↔pg parity (real Postgres)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
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
    const sqlDir = path.resolve(thisDir, '..', '..', '..', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  afterEach(async () => {
    const pool = getPgPool();
    await pool.query('TRUNCATE bars, bar_revisions_log');
    delete process.env.BARS_BACKEND;
  });

  async function seedBars(docs: Array<Record<string, unknown>>) {
    const pool = getPgPool();
    for (const d of docs) {
      await pool.query(
        `INSERT INTO bars (symbol, market, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         VALUES ($1, $2, $3, $4, $5, 1, 1, 1, 1, 1, 1, $6, $7)`,
        [d.symbol, d.market, d.observation_ts, (d.knowledge_ts as number) + (d.is_superseded ? 1 : 0),
         d.interval ?? '5m', `h${d.symbol}${d.observation_ts}${d.is_superseded ? 's' : ''}`, d.is_superseded ?? false],
      );
    }
  }
  async function seedRevs(docs: Array<Record<string, unknown>>) {
    const pool = getPgPool();
    for (const d of docs) {
      await pool.query(
        `INSERT INTO bar_revisions_log (symbol, market, observation_ts, interval, knowledge_ts, prior_hash, new_hash)
         VALUES ($1, $2, $3, '5m', $4, $5, 'h')`,
        [d.symbol, d.market, d.observation_ts, d.knowledge_ts, d.prior_hash],
      );
    }
  }

  it('count / latest / observed / revisions all agree across Mongo and pg', async () => {
    const bars = [
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 10 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight + 5 * 60_000, { superseded: true }),   // excluded everywhere
      makeBarsDoc('MSFT', 'US', utcMidnight + 7 * 60_000),
      makeBarsDoc('SHEL', 'LSE', utcMidnight + 6 * 60_000),
      makeBarsDoc('AAPL', 'US', utcMidnight - 5 * 60_000),                         // before the floor
    ];
    const revs = [
      makeRevDoc('AAPL', 'US', utcMidnight, utcMidnight + 1, null),                // first-print
      makeRevDoc('AAPL', 'US', utcMidnight, utcMidnight + 2, 'prev'),              // revision
      makeRevDoc('MSFT', 'US', utcMidnight, utcMidnight + 1, 'prev'),              // revision
    ];
    await seedBars(bars);
    await seedRevs(revs);
    const ids = [AAPL, MSFT, SHEL];
    const sinceMs = utcMidnight;

    process.env.BARS_BACKEND = 'timescale';
    const pgObs   = (await getObservedTimestamps(undefined, 'AAPL_US_EQ', '5m', utcMidnight, utcMidnight + day)).sort();
    const pgCount = await countBarsForTickers(undefined, ids, '5m', sinceMs);
    const pgAll   = await countAllBars(undefined, '5m', sinceMs);
    const pgLatest = await latestObservationForTickers(undefined, ids, '5m', sinceMs);
    const pgRevs  = await countRevisionsForTickers(undefined, '5m');

    delete process.env.BARS_BACKEND;
    const db = makeDb(bars, revs);
    const moObs   = (await getObservedTimestamps(db, 'AAPL_US_EQ', '5m', utcMidnight, utcMidnight + day)).sort();
    const moCount = await countBarsForTickers(db, ids, '5m', sinceMs);
    const moAll   = await countAllBars(db, '5m', sinceMs);
    const moLatest = await latestObservationForTickers(db, ids, '5m', sinceMs);
    const moRevs  = await countRevisionsForTickers(db, '5m');

    expect(pgObs).toEqual(moObs);
    expect(pgObs).toEqual([utcMidnight + 5 * 60_000, utcMidnight + 10 * 60_000]);
    expect([...pgCount.entries()].sort()).toEqual([...moCount.entries()].sort());
    expect(pgCount.get('AAPL|US')).toBe(2);  // superseded + pre-floor excluded
    expect([...pgAll.entries()].sort()).toEqual([...moAll.entries()].sort());
    expect([...pgLatest.entries()].sort()).toEqual([...moLatest.entries()].sort());
    expect(pgLatest.get('AAPL|US')).toBe(utcMidnight + 10 * 60_000);
    expect([...pgRevs.entries()].sort()).toEqual([...moRevs.entries()].sort());
    expect(pgRevs.get('AAPL|US')).toBe(1);   // first-print excluded
  }, TEST_TIMEOUT_MS);

  it('getRevisionsForTicker agrees across Mongo and pg (newest-first, cutoff, limit)', async () => {
    const revs = [
      makeRevDoc('AAPL', 'US', utcMidnight, 100, null),
      makeRevDoc('AAPL', 'US', utcMidnight + 60_000, 200, 'h1'),
      makeRevDoc('AAPL', 'US', utcMidnight + 120_000, 50, 'h0'),  // before cutoff 100
      makeRevDoc('MSFT', 'US', utcMidnight, 300, 'h2'),
    ];
    await seedRevs(revs);

    process.env.BARS_BACKEND = 'timescale';
    const pg = await getRevisionsForTicker(undefined, 'AAPL', 'US', 100, 50);
    delete process.env.BARS_BACKEND;
    const mo = await getRevisionsForTicker(makeDb([], revs), 'AAPL', 'US', 100, 50);

    expect(pg.map((r) => r.knowledge_ts)).toEqual([200, 100]);
    expect(mo.map((r) => r.knowledge_ts)).toEqual([200, 100]);
    expect(pg.every((r) => r.symbol === 'AAPL')).toBe(true);
  }, TEST_TIMEOUT_MS);
});

// The bounded-read regression for the whole-store count: a many-chunk daily hypertable makes an
// UNBOUNDED count(*) group-by lock every chunk at executor startup → "out of shared memory" under a
// tight lock budget. countAllBars carries an `observation_ts >= sinceMs` floor, so it prunes to the
// window's chunks. (Same proof the at-or-before / recent-set-read suites pin, asserted for the count.)
const OOM_MAX_LOCKS = 16;
const OOM_MAX_CONNECTIONS = 10;
const INSERT_BATCH_MS = 90 * day;

describe.skipIf(!dockerAvailable)('countAllBars — many-chunk bounded-read (OOM regression)', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
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
    const sqlDir = path.resolve(thisDir, '..', '..', '..', 'shared-pg', 'sql');
    await runMigrations(sqlDir, pool);

    // Deep daily series 2006→now for AAPL (~1000+ 7-day chunks), inserted in ≤90-day batches.
    const startTs = Date.UTC(2006, 0, 1);
    const endTs = Date.now();
    for (let lo = startTs; lo < endTs; lo += INSERT_BATCH_MS) {
      const hi = Math.min(lo + INSERT_BATCH_MS - day, endTs);
      await pool.query(
        `INSERT INTO bars (symbol, market, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         SELECT 'AAPL', 'US', g, g, 'daily', 10, 10, 10, 10, 1000, 10, 'h' || g::text, FALSE
           FROM generate_series($1::bigint, $2::bigint, $3::bigint) AS g`,
        [lo, hi, day],
      );
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  it('an UNBOUNDED whole-store count(*) group-by exhausts the lock table — the regression', async () => {
    const pool = getPgPool();
    await expect(
      pool.query(
        `SELECT symbol, market, count(*)::bigint AS n
           FROM bars
          WHERE interval = $1 AND is_superseded = FALSE
          GROUP BY symbol, market`,
        ['daily'],
      ),
    ).rejects.toMatchObject({ code: '53200' });
  });

  it('the bounded countAllBars returns the recent count WITHOUT OOMing', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const sinceMs = Date.now() - 10 * day;
    const counts = await countAllBars(undefined, 'daily', sinceMs);
    const n = counts.get('AAPL|US') ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(20);  // bounded — not the whole 2006→now series
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
