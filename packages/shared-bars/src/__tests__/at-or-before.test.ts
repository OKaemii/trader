// Tests for getBarAtOrBefore — the single-bar at-or-before read that replaces the range='max'
// series scan in the PIT market-cap / dividend-yield enrichment. The read is BOUNDED BELOW at the
// anchor (`asOf`, or `now` for live) so chunk-exclusion prunes the read to a bounded slice of
// chunks on BOTH bounds — the load-bearing fix for the production OOM (an unbounded DESC-LIMIT-1
// locked every chunk of a deep daily series → "out of shared memory").
//
// The load-bearing guarantees:
//   • Live path (asOf undefined) — newest unsuperseded bar within a window anchored at `now`
//     (primary ~400d, one wider ~5y fallback). A bar older than the wide window is NOT reachable
//     live; deep history is read via an as-of anchored there instead.
//   • As-of path (asOf set) — newest observation_ts <= asOf within a window anchored at `asOf`,
//     picking the latest revision known at asOf; a revision whose knowledge_ts is after asOf is
//     invisible. A 2006 asOf reads only the chunks around 2006.
//   • Cache key uses the distinct `:at:` segment (never collides with the windowed-series keys).
//   • Dispatcher routes mongo vs timescale by BARS_BACKEND; db=undefined on the mongo default throws.
//   • PG path (testcontainers): the bounded read returns one row for a recent AND a 2006 asOf, and a
//     many-chunk hypertable proves the OLD unbounded query OOMs (low max_locks_per_transaction) while
//     the NEW bounded read does not — the regression the whole card exists to kill.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBarAtOrBefore, getDailyDepth } from '../index.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 120_000;

// In-memory Redis stub — records every get/setEx so tests can assert the `:at:` cache key.
function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'setEx'; key: string }> = [];
  return {
    store, calls,
    get: async (key: string) => { calls.push({ op: 'get', key }); return store.get(key) ?? null; },
    setEx: async (key: string, _ttl: number, value: string) => {
      calls.push({ op: 'setEx', key });
      store.set(key, value);
      return 'OK' as const;
    },
  };
}

// In-memory Mongo collection: enough of find().sort().limit() and the aggregate pipeline
// (with $limit) to exercise getBarAtOrBefore. Records find filters + aggregate pipelines.
function makeCollectionWith(docs: Array<Record<string, unknown>>) {
  const findFilters: Array<Record<string, unknown>> = [];
  const aggregatePipelines: Array<Array<Record<string, unknown>>> = [];
  return {
    findFilters,
    aggregatePipelines,
    find: (filter: Record<string, unknown>) => {
      findFilters.push(filter);
      let matched = docs.filter((d) => matchFilter(d, filter));
      let sortSpec: Record<string, number> | null = null;
      let limitN: number | null = null;
      const cursor = {
        sort: (s: Record<string, number>) => { sortSpec = s; return cursor; },
        limit: (n: number) => { limitN = n; return cursor; },
        toArray: async () => {
          if (sortSpec) matched = sortDocs(matched, sortSpec);
          return limitN != null ? matched.slice(0, limitN) : matched;
        },
      };
      return cursor;
    },
    aggregate: (pipeline: Array<Record<string, unknown>>) => {
      aggregatePipelines.push(pipeline);
      let stream = docs.slice();
      for (const stage of pipeline) {
        if ('$match' in stage) stream = stream.filter((d) => matchFilter(d, stage.$match as Record<string, unknown>));
        else if ('$sort' in stage) stream = sortDocs(stream, stage.$sort as Record<string, number>);
        else if ('$group' in stage) {
          const g = stage.$group as { _id: string; doc: { $first: string } };
          const idField = (g._id as string).replace(/^\$/, '');
          const seen = new Map<unknown, Record<string, unknown>>();
          for (const d of stream) if (!seen.has(d[idField])) seen.set(d[idField], d);
          stream = Array.from(seen.values()).map((d) => ({ _id: d[idField], doc: d }));
        }
        else if ('$replaceRoot' in stage) stream = stream.map((s) => (s as { doc: Record<string, unknown> }).doc);
        else if ('$limit' in stage) stream = stream.slice(0, stage.$limit as number);
      }
      return { toArray: async () => stream };
    },
  };
}

function sortDocs(docs: Array<Record<string, unknown>>, spec: Record<string, number>): Array<Record<string, unknown>> {
  const keys = Object.entries(spec);
  return docs.slice().sort((a, b) => {
    for (const [k, dir] of keys) {
      const av = a[k]; const bv = b[k];
      if (av === bv) continue;
      return (av! > bv! ? 1 : -1) * dir;
    }
    return 0;
  });
}

function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ('$gte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >= (ops.$gte as number))) return false;
      if ('$gt'  in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >  (ops.$gt  as number))) return false;
      if ('$lte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) <= (ops.$lte as number))) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeDb(coll: ReturnType<typeof makeCollectionWith>) {
  return { collection: () => coll } as never;
}

const _now = Date.now();
const day = 24 * 60 * 60 * 1000;

describe('getBarAtOrBefore — Mongo live path (asOf undefined)', () => {
  it('returns the newest unsuperseded bar and carries the asOf-anchored window bound', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: _now - 5*day, knowledge_ts: _now - 5*day, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 10, volume: 1 },
      { ticker: 'A', observation_ts: _now - 1*day, knowledge_ts: _now - 1*day, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 20, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily');
    expect(bar?.close).toBe(20);                       // newest within the window
    // The filter is BOUNDED below at `now - window` (this bound is the OOM fix — it prunes the
    // per-chunk lock fan on Timescale). Upper bound `$lte: now`, lower bound `$gt: now - window`.
    const f = coll.findFilters[0] as { is_superseded?: boolean; observation_ts?: { $lte: number; $gt: number } };
    expect(f.is_superseded).toBe(false);
    expect(f.observation_ts).toBeDefined();
    expect(f.observation_ts!.$gt).toBeLessThan(f.observation_ts!.$lte);
  });

  it('expands once to a wider bounded window when the primary window is empty', async () => {
    delete process.env.BARS_BACKEND;
    // The only bar sits ~600 days back — outside the ~400d primary, inside the ~5y wide fallback.
    const ts = _now - 600 * day;
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: ts, knowledge_ts: ts, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 42, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily');
    expect(bar?.close).toBe(42);
    expect(bar?.observation_ts).toBe(ts);
    // Two reads: the empty primary then the wider fallback. The fallback's lower bound is deeper.
    expect(coll.findFilters).toHaveLength(2);
    const primary = coll.findFilters[0] as { observation_ts: { $gt: number } };
    const wide    = coll.findFilters[1] as { observation_ts: { $gt: number } };
    expect(wide.observation_ts.$gt).toBeLessThan(primary.observation_ts.$gt);
  });

  it('returns null for a bar older than even the wide window (never widens unbounded)', async () => {
    delete process.env.BARS_BACKEND;
    // A 2006 bar is outside the ~5y wide window when read LIVE ('now') — deep reads must pass asOf.
    const oldTs = Date.UTC(2006, 5, 15);
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: oldTs, knowledge_ts: oldTs, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 42, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily');
    expect(bar).toBeNull();
    // Confirms the window never widens to the whole series: both reads keep a finite lower bound.
    expect(coll.findFilters).toHaveLength(2);
    for (const f of coll.findFilters) {
      expect((f as { observation_ts: { $gt: number } }).observation_ts.$gt).toBeGreaterThan(0);
    }
  });

  it('returns null when the ticker has no bars', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'NONE', 'daily');
    expect(bar).toBeNull();
  });

  it('writes the cache under the distinct :at: segment (live bucket)', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([]);
    const redis = makeRedis();
    await getBarAtOrBefore(redis as never, makeDb(coll), 'A', 'daily');
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual(['bars:v2:A:daily:at:live']);
  });
});

describe('getBarAtOrBefore — Mongo as-of path (asOf set)', () => {
  it('picks the newest observation_ts <= asOf and the latest revision known at asOf', async () => {
    delete process.env.BARS_BACKEND;
    const obsOld = _now - 5 * day;
    const obsNew = _now - 1 * day;
    const kNewLate = obsNew + 3 * 60_000;
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: obsOld, knowledge_ts: obsOld,      interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 5,   volume: 1 },
      { ticker: 'A', observation_ts: obsNew, knowledge_ts: obsNew,      interval: 'daily', is_superseded: true,  open: 1, high: 1, low: 1, close: 100, volume: 1 },
      { ticker: 'A', observation_ts: obsNew, knowledge_ts: kNewLate,    interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 101, volume: 1 },
    ]);
    // asOf after the late revision → newest observation (obsNew) at its latest known revision (101).
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily', { asOf: kNewLate + 1 });
    expect(bar?.observation_ts).toBe(obsNew);
    expect(bar?.close).toBe(101);
  });

  it('reaches a deep 2006 observation when asOf anchors the window there', async () => {
    delete process.env.BARS_BACKEND;
    // The real PIT usage: a deep historical read passes asOf, so the window anchors at 2006 — the
    // bar that a LIVE ('now') read would (correctly) not reach.
    const obs2006 = Date.UTC(2006, 0, 3);
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: obs2006, knowledge_ts: obs2006, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 11, volume: 1 },
      { ticker: 'A', observation_ts: _now - 1*day, knowledge_ts: _now - 1*day, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 99, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily', { asOf: obs2006 + day });
    expect(bar?.observation_ts).toBe(obs2006);
    expect(bar?.close).toBe(11);
    // The window is anchored at asOf (2006), not now: upper bound is asOf, lower bound is asOf - window.
    const f = coll.findFilters[0] as { observation_ts: { $lte: number; $gt: number } };
    expect(f.observation_ts.$lte).toBe(obs2006 + day);
    expect(f.observation_ts.$gt).toBeLessThan(obs2006 + day);
  });

  it('ignores a revision whose knowledge_ts is after asOf (falls back to the prior revision)', async () => {
    delete process.env.BARS_BACKEND;
    const obs = _now - 1 * day;
    const kEarly = obs + 60_000;
    const kLate  = obs + 5 * 60_000;
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: obs, knowledge_ts: kEarly, interval: 'daily', is_superseded: true,  open: 1, high: 1, low: 1, close: 50, volume: 1 },
      { ticker: 'A', observation_ts: obs, knowledge_ts: kLate,  interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 60, volume: 1 },
    ]);
    // asOf between the two revisions → only the early one is knowable.
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily', { asOf: kLate - 1 });
    expect(bar?.close).toBe(50);
  });

  it('returns null when every observation_ts is after asOf', async () => {
    delete process.env.BARS_BACKEND;
    const obs = _now;
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: obs, knowledge_ts: obs, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 9, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily', { asOf: obs - day });
    expect(bar).toBeNull();
  });

  it('keys an as-of read under a minute-bucketed :at: segment, distinct from live', async () => {
    delete process.env.BARS_BACKEND;
    const coll = makeCollectionWith([]);
    const redis = makeRedis();
    const asOf = 1_700_000_000_000;
    await getBarAtOrBefore(redis as never, makeDb(coll), 'A', 'daily', { asOf });
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual([`bars:v2:A:daily:at:${Math.floor(asOf / 60_000)}`]);
  });
});

describe('getBarAtOrBefore — dispatcher', () => {
  it('throws when db is undefined and BARS_BACKEND defaults to mongo', async () => {
    delete process.env.BARS_BACKEND;
    await expect(
      getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily'),
    ).rejects.toThrow(/db parameter required/);
  });
});

describe.skipIf(!dockerAvailable)('getBarAtOrBefore — real Postgres (the OOM regression)', () => {
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
  });

  it('the bars_asof_lookup index exists after migration', async () => {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'bars' AND indexname = 'bars_asof_lookup'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('reaches a 2006 bar via an as-of read AND now live — each one bounded row', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const pool = getPgPool();
    const oldTs = Date.UTC(2006, 0, 3);
    const recentTs = Date.now() - 24 * 60 * 60 * 1000;
    // Two bars 18+ years apart — the span that opened ~5,200 chunks under range='max'.
    for (const [ts, close] of [[oldTs, 11.0], [recentTs, 99.0]] as Array<[number, number]>) {
      await pool.query(
        `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         VALUES ('A', $1, $1, 'daily', $2, $2, $2, $2, 1000, $2, $3, FALSE)`,
        [ts, close, `h${ts}`],
      );
    }

    // Live: the newest bar (the window anchors at now).
    const live = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily');
    expect(live?.close).toBe(99.0);

    // As-of in 2006: the window anchors at asOf (2006), so the deep bar is reachable — the read the
    // OOM scan could never complete.
    const deep = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily', { asOf: oldTs + day });
    expect(deep?.close).toBe(11.0);
    expect(deep?.observation_ts).toBe(oldTs);

    // Cache lands under the PG :at: namespace.
    const redis = makeRedis();
    await getBarAtOrBefore(redis as never, undefined, 'A', 'daily');
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual(['bars:pg:v1:A:daily:at:live']);
  }, TEST_TIMEOUT_MS);

  it('as-of excludes a revision whose knowledge_ts is after asOf', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const pool = getPgPool();
    const obs = Date.UTC(2020, 0, 2);
    const kEarly = obs + 60_000;
    const kLate  = obs + 5 * 60_000;
    // First-print then a later revision of the same observation.
    await pool.query(
      `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                         open, high, low, close, volume, raw_close, content_hash, is_superseded)
       VALUES ('A', $1, $2, 'daily', 50, 50, 50, 50, 1, 50, 'h1', TRUE)`,
      [obs, kEarly],
    );
    await pool.query(
      `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                         open, high, low, close, volume, raw_close, content_hash, is_superseded)
       VALUES ('A', $1, $2, 'daily', 60, 60, 60, 60, 1, 60, 'h2', FALSE)`,
      [obs, kLate],
    );
    const early = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily', { asOf: kLate - 1 });
    expect(early?.close).toBe(50);
    const late = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily', { asOf: kLate + 1 });
    expect(late?.close).toBe(60);
  }, TEST_TIMEOUT_MS);
});

// The regression that shipped and OOM'd in production (card #156 QA FAILED): a many-chunk bars
// hypertable (daily 2006→now, 7-day chunks ≈ 1000+ chunks) makes an UNBOUNDED `… ORDER BY
// observation_ts DESC LIMIT 1` plan a `Merge Append` over EVERY chunk's index scan — the executor
// locks all of them at startup, before LIMIT can short-circuit — and the shared lock table overflows
// → "out of shared memory" (lock.c LockAcquireExtended, SQLSTATE 53200). The lock table is sized
// `max_locks_per_transaction × (max_connections + …)`, so we shrink BOTH (16 × 10) to make ~1000
// chunk locks overflow it deterministically; the table is loaded in ≤90-day batches (each
// transaction touches few chunks, under the tight budget). The OLD unbounded query MUST then error;
// the NEW asOf-anchored bounded `getBarAtOrBefore` MUST succeed for BOTH a recent and a ~2006 asOf.
// The original unit test only built a couple of chunks and never reproduced the lock explosion —
// this is the gap that let the OOM ship. (Verified: removing the lower bound makes this block fail.)
const OOM_MAX_LOCKS = 16;
const OOM_MAX_CONNECTIONS = 10;
const INSERT_BATCH_MS = 90 * 24 * 60 * 60 * 1000;

describe.skipIf(!dockerAvailable)('getBarAtOrBefore — many-chunk lock-table OOM regression', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'trader_ts' })
      .withExposedPorts(5432)
      // Small shared lock table — the whole point: locking ~1000 chunks in one plan must overflow it.
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

    // Build a deep daily series 2006-01-01 → now (7-day chunks ⇒ ~1000+ chunks). Insert in ≤90-day
    // batches: each batch's transaction touches ~13 chunks, which fits the tight lock budget, while
    // a single all-chunk INSERT would itself overflow it.
    const startTs = Date.UTC(2006, 0, 1);
    const endTs = Date.now();
    for (let lo = startTs; lo < endTs; lo += INSERT_BATCH_MS) {
      const hi = Math.min(lo + INSERT_BATCH_MS - 24 * 60 * 60 * 1000, endTs);
      await pool.query(
        `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                           open, high, low, close, volume, raw_close, content_hash, is_superseded)
         SELECT 'A', g, g, 'daily', 10, 10, 10, 10, 1000, 10, 'h' || g::text, FALSE
           FROM generate_series($1::bigint, $2::bigint, $3::bigint) AS g`,
        [lo, hi, 24 * 60 * 60 * 1000],
      );
    }
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await closePgPool();
    await container?.stop();
    delete process.env.BARS_BACKEND;
  }, TEST_TIMEOUT_MS);

  it('the hypertable really spans many chunks (the OOM precondition)', async () => {
    const pool = getPgPool();
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    // ~1000+ for a 2006→now daily series at 7-day chunks; assert well past the tight lock budget.
    expect(rows[0].n).toBeGreaterThan(200);
  });

  it('the OLD unbounded DESC-LIMIT-1 query exhausts the lock table (reproduces the production OOM)', async () => {
    const pool = getPgPool();
    // The exact shape that shipped in 5a73c45: no observation_ts lower bound. Its plan is a Merge
    // Append over every chunk's index scan; the executor locks them all → "out of shared memory"
    // (SQLSTATE 53200, lock.c:1033 LockAcquireExtended) under the tight lock table. This is the
    // assertion that the original unit test was missing — it must FAIL if the lower bound is removed.
    await expect(
      pool.query(
        `SELECT ticker, observation_ts, close
           FROM bars
          WHERE ticker = $1 AND interval = $2 AND is_superseded = FALSE
          ORDER BY observation_ts DESC
          LIMIT 1`,
        ['A', 'daily'],
      ),
    ).rejects.toMatchObject({ code: '53200' }); // 53200 = out_of_memory (shared lock table)
  });

  it('the NEW bounded getBarAtOrBefore does NOT exhaust locks — recent AND deep 2006 asOf both return', async () => {
    process.env.BARS_BACKEND = 'timescale';
    // Live ('now'): returns the most recent bar without the lock fan the old query hit above.
    const live = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily');
    expect(live).not.toBeNull();
    expect(live?.close).toBe(10);

    // Deep as-of (~2006): the window anchors at asOf, so it touches only the chunks around 2006 —
    // reachable AND lock-safe. This is the read that 500'd in production.
    const asOf2006 = Date.UTC(2006, 5, 15);
    const deep = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily', { asOf: asOf2006 });
    expect(deep).not.toBeNull();
    expect(deep!.observation_ts).toBeLessThanOrEqual(asOf2006);
    // The returned bar is the latest daily bar at/<= the asOf (within a day of it).
    expect(asOf2006 - deep!.observation_ts).toBeLessThan(2 * day);
  }, TEST_TIMEOUT_MS);

  it('EXPLAIN of the bounded read prunes to a bounded chunk count (not the whole hypertable)', async () => {
    const pool = getPgPool();
    // The bounded read the resolver runs for a deep asOf: a ~400d window around 2006. Chunk
    // exclusion must keep the plan to far fewer chunks than the full series (≈1000) — bounded both
    // sides. We count Scan nodes naming a `_hyper_*_*_chunk` relation in the plan text.
    const asOf2006 = Date.UTC(2006, 5, 15);
    const windowMs = 400 * day;
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT ticker, observation_ts, knowledge_ts, close
         FROM bars
        WHERE ticker = $1 AND interval = $2
          AND observation_ts <= $3 AND observation_ts > $4
          AND knowledge_ts <= $3
        ORDER BY observation_ts DESC, knowledge_ts DESC
        LIMIT 1`,
      ['A', 'daily', asOf2006, asOf2006 - windowMs],
    );
    const plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    const chunkScans = (plan.match(/_hyper_\d+_\d+_chunk/g) ?? []).length;
    // ~57 chunks for a 400d window; assert it's a small bounded slice, nowhere near the full ~1000.
    expect(chunkScans).toBeLessThan(120);
  });

  // ── Depth-check (getDailyDepth) on the SAME deep many-chunk series ──────────────────────────────
  // The capstone depth-check proves how far back the daily series reaches. It must compute
  // {oldest, count} WITHOUT the unbounded aggregate that OOMs (the card's explicit constraint).

  it('the NAIVE unbounded min()/count() aggregate exhausts the lock table (why the walk is required)', async () => {
    const pool = getPgPool();
    // This is the query the card warns against: `SELECT min(observation_ts), count(*) … WHERE
    // ticker=$1 AND interval='daily' AND is_superseded=FALSE` with NO time bound. On the deep series
    // its plan touches every chunk and locks them all at executor startup → "out of shared memory"
    // (SQLSTATE 53200) under the tight lock budget — exactly the failure getDailyDepth's bounded
    // walk avoids. If this ever STOPS erroring, the bounded walk's necessity should be re-checked.
    await expect(
      pool.query(
        `SELECT min(observation_ts) AS oldest, count(*)::bigint AS n
           FROM bars
          WHERE ticker = $1 AND interval = $2 AND is_superseded = FALSE`,
        ['A', 'daily'],
      ),
    ).rejects.toMatchObject({ code: '53200' });
  });

  it('getDailyDepth returns the 2006 oldest + full count over the deep series WITHOUT OOMing', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const depth = await getDailyDepth(undefined, 'A', 'daily');
    // Oldest reaches the 2006 floor of the seeded series (within a chunk of 2006-01-01).
    expect(depth.oldest).not.toBeNull();
    expect(depth.oldest!).toBeLessThanOrEqual(Date.UTC(2006, 0, 8));
    expect(depth.oldest!).toBeGreaterThanOrEqual(Date.UTC(2006, 0, 1));
    // The seeded series is one bar per day 2006→now → thousands of rows; assert it counted the lot
    // (well past any single window), proving the bounded walk accumulates across windows.
    expect(depth.count).toBeGreaterThan(5000);
  }, TEST_TIMEOUT_MS);

  it('EXPLAIN of the depth WINDOW query prunes to a bounded chunk count (each walk step is bounded)', async () => {
    const pool = getPgPool();
    // The total chunk count of the deep series (2006→now @ 7-day chunks ≈ 1000+) — the count the
    // naive unbounded aggregate would lock. The bounded window step must touch a small FRACTION of it.
    const { rows: totalRows } = await pool.query(
      `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'bars'`,
    );
    const totalChunks = totalRows[0].n as number;

    // One step of the depth walk: a bounded [lo, hi) window. Chunk exclusion must keep it to a small
    // slice — the per-query lock footprint that keeps the walk OOM-safe.
    const lo = Date.UTC(2006, 0, 1);
    const hi = lo + 730 * day; // the 2y DEPTH_WINDOW
    const { rows } = await pool.query(
      `EXPLAIN (FORMAT TEXT)
       SELECT count(*)::bigint AS n, min(observation_ts) AS oldest
         FROM bars
        WHERE ticker = $1 AND interval = $2 AND is_superseded = FALSE
          AND observation_ts >= $3 AND observation_ts < $4`,
      ['A', 'daily', lo, hi],
    );
    const plan = rows.map((r) => r['QUERY PLAN'] as string).join('\n');
    const chunkScans = (plan.match(/_hyper_\d+_\d+_chunk/g) ?? []).length;
    // A 730d window is ~210 chunk-scan nodes — a small slice of the ~1000+ total. The point is that
    // chunk exclusion PRUNES (the window step never plans over the whole hypertable like the naive
    // aggregate above): assert it's well under a third of the full series.
    expect(chunkScans).toBeGreaterThan(0);
    expect(chunkScans).toBeLessThan(totalChunks / 3);
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
