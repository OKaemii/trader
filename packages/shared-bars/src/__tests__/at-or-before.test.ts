// Tests for getBarAtOrBefore — the single-bar, NO-LOWER-BOUND as-of read that replaces the
// range='max' series scan in the PIT market-cap / dividend-yield enrichment.
//
// The load-bearing guarantees:
//   • Live path (asOf undefined) — newest unsuperseded bar via find().sort(DESC).limit(1),
//     with NO observation_ts lower bound (so a bar from 2006 is reachable just as 'now' is).
//   • As-of path (asOf set) — newest observation_ts <= asOf, picking the latest revision known
//     at asOf; a revision whose knowledge_ts is after asOf is invisible.
//   • Cache key uses the distinct `:at:` segment (never collides with the windowed-series keys).
//   • Dispatcher routes mongo vs timescale by BARS_BACKEND; db=undefined on the mongo default throws.
//   • PG path (testcontainers): a deep-old bar AND 'now' both return one row — the OOM regression
//     the whole card exists to kill — and the cache key lands under the bars:pg:v1:…:at:… namespace.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBarAtOrBefore } from '../index.ts';

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
  it('returns the newest unsuperseded bar with no observation_ts lower bound', async () => {
    delete process.env.BARS_BACKEND;
    // A very old bar (2006) and a recent one — the old one must still be reachable (no lower bound).
    const oldTs = Date.UTC(2006, 0, 3);
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: oldTs,        knowledge_ts: oldTs,        interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 10, volume: 1 },
      { ticker: 'A', observation_ts: _now - 1*day, knowledge_ts: _now - 1*day, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 20, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily');
    expect(bar?.close).toBe(20);                       // newest
    // The filter carries NO observation_ts bound — the OOM-causing lower bound is gone.
    expect(coll.findFilters[0]).toMatchObject({ ticker: 'A', interval: 'daily', is_superseded: false });
    expect(coll.findFilters[0]).not.toHaveProperty('observation_ts');
  });

  it('reaches a single 2006 bar when it is the only one (no lower bound clips it)', async () => {
    delete process.env.BARS_BACKEND;
    const oldTs = Date.UTC(2006, 5, 15);
    const coll = makeCollectionWith([
      { ticker: 'A', observation_ts: oldTs, knowledge_ts: oldTs, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 42, volume: 1 },
    ]);
    const bar = await getBarAtOrBefore(makeRedis() as never, makeDb(coll), 'A', 'daily');
    expect(bar?.close).toBe(42);
    expect(bar?.observation_ts).toBe(oldTs);
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

  it('reaches a 2006 bar AND now in one row each — no lower bound, no chunk fan', async () => {
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

    // Live: the newest bar.
    const live = await getBarAtOrBefore(makeRedis() as never, undefined, 'A', 'daily');
    expect(live?.close).toBe(99.0);

    // As-of in 2006: the 2006 bar — the deep read the OOM scan could never complete.
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

async function isDockerAvailable(): Promise<boolean> {
  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 3000 });
    return result.status === 0;
  } catch {
    return false;
  }
}
