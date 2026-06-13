// Tests for getBars `asOf` behaviour — locks in the bi-temporal contract from
// agent-docs/plans/point-in-time-bar-history.md.
//
// Coverage:
//   • Live path (asOf undefined) — Mongo query filters is_superseded:false,
//     ranges on observation_ts, sorts ascending.
//   • As-of path (asOf number) — aggregation matches knowledge_ts <= asOf,
//     groups per observation_ts picking the latest revision, sorts ascending.
//   • Cache-key bucketing — live and as-of reads land on distinct keys; same-minute
//     as-of reads share a key (1-minute bucket).
//   • docToBar handles both new (observation_ts:number) and legacy (timestamp:Date)
//     persisted shapes.

import { describe, it, expect } from "vitest";
import { getBars } from '../index.ts';

// In-memory Redis stub — tracks every get/setEx so tests can assert cache keys.
function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'setEx'; key: string }> = [];
  return {
    store, calls,
    get: async (key: string) => {
      calls.push({ op: 'get', key });
      return store.get(key) ?? null;
    },
    setEx: async (key: string, _ttl: number, value: string) => {
      calls.push({ op: 'setEx', key });
      store.set(key, value);
      return 'OK' as const;
    },
  };
}

// In-memory Mongo collection that records every find / aggregate filter the
// caller passes and returns the docs the test fixed up-front. Mirrors the
// chained-cursor shape Mongo's driver uses.
function makeCollectionWith(docs: Array<Record<string, unknown>>) {
  const findFilters: Array<Record<string, unknown>> = [];
  const aggregatePipelines: Array<Array<Record<string, unknown>>> = [];
  return {
    findFilters,
    aggregatePipelines,
    find: (filter: Record<string, unknown>) => {
      findFilters.push(filter);
      const matched = docs.filter((d) => matchFilter(d, filter));
      return {
        sort: (_s: Record<string, number>) => ({
          toArray: async () => matched,
        }),
      };
    },
    aggregate: (pipeline: Array<Record<string, unknown>>) => {
      aggregatePipelines.push(pipeline);
      // Execute a minimal slice of the aggregation: $match → $sort → $group({_id, $first}) → $replaceRoot → $sort.
      let stream = docs.slice();
      for (const stage of pipeline) {
        if ('$match' in stage) stream = stream.filter((d) => matchFilter(d, stage.$match as Record<string, unknown>));
        else if ('$sort' in stage) {
          const keys = Object.entries(stage.$sort as Record<string, number>);
          stream.sort((a, b) => {
            for (const [k, dir] of keys) {
              const av = a[k]; const bv = b[k];
              if (av === bv) continue;
              return (av! > bv! ? 1 : -1) * dir;
            }
            return 0;
          });
        }
        else if ('$group' in stage) {
          const g = stage.$group as { _id: string; doc: { $first: string } };
          const idField = (g._id as string).replace(/^\$/, '');
          const seen = new Map<unknown, Record<string, unknown>>();
          for (const d of stream) {
            if (!seen.has(d[idField])) seen.set(d[idField], d);
          }
          stream = Array.from(seen.values()).map((d) => ({ _id: d[idField], doc: d }));
        }
        else if ('$replaceRoot' in stage) {
          stream = stream.map((s) => (s as { doc: Record<string, unknown> }).doc);
        }
      }
      return { toArray: async () => stream };
    },
  };
}

// Tiny filter matcher — enough for { field, field:{$gte,$lte} } predicates.
function matchFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ops = v as Record<string, unknown>;
      if ('$gte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) >= (ops.$gte as number))) return false;
      if ('$lte' in ops && !(typeof doc[k] === 'number' && (doc[k] as number) <= (ops.$lte as number))) return false;
      if ('$in'  in ops && !((ops.$in as unknown[]).includes(doc[k]))) return false;
    } else if (doc[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeDb(coll: ReturnType<typeof makeCollectionWith>) {
  return { collection: () => coll } as any;
}

const _now = Date.now();
const day = 24 * 60 * 60 * 1000;

describe('getBars — live path (asOf undefined)', () => {
  it('queries with is_superseded:false and observation_ts $gte sinceTs', async () => {
    const coll = makeCollectionWith([
      { symbol: 'A', market: 'US', observation_ts: _now - 2 * day, knowledge_ts: _now - 2 * day, interval: '5m', is_superseded: false, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { symbol: 'A', market: 'US', observation_ts: _now - 1 * day, knowledge_ts: _now - 1 * day, interval: '5m', is_superseded: false, open: 2, high: 3, low: 1.5, close: 2.5, volume: 200 },
    ]);
    const redis = makeRedis();
    const bars = await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d');
    expect(bars).toHaveLength(2);
    expect(coll.findFilters).toHaveLength(1);
    // The T212 ticker is split to (symbol, market) at the storage boundary.
    expect(coll.findFilters[0]).toMatchObject({ symbol: 'A', market: 'US', interval: '5m', is_superseded: false });
    expect((coll.findFilters[0].observation_ts as { $gte: number }).$gte).toBeLessThanOrEqual(_now - 30 * day + 1000);
  });

  it('uses cache key with "live" bucket', async () => {
    const coll = makeCollectionWith([]);
    const redis = makeRedis();
    await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d');
    const setCalls = redis.calls.filter((c) => c.op === 'setEx');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].key).toBe('bars:v2:A:US:5m:30d:live');
  });
});

describe('getBars — as-of path (asOf set)', () => {
  it('runs an aggregation that picks the latest knowledge_ts <= asOf per observation_ts', async () => {
    // Two revisions of the same observation_ts. asOf at the earlier knowledge_ts
    // returns the earlier revision; asOf at the later returns the later.
    const obsTs = _now - 1 * day;
    const k1 = _now - 1 * day + 60_000;        // 1 min after obs
    const k2 = _now - 1 * day + 3 * 60_000;    // 3 min after obs
    const docs = [
      { symbol: 'A', market: 'US', observation_ts: obsTs, knowledge_ts: k1, interval: '5m', is_superseded: true,  open: 1, high: 1, low: 1, close: 100, volume: 1 },
      { symbol: 'A', market: 'US', observation_ts: obsTs, knowledge_ts: k2, interval: '5m', is_superseded: false, open: 1, high: 1, low: 1, close: 101, volume: 1 },
    ];

    const earlyColl = makeCollectionWith(docs);
    const earlyBars = await getBars(makeRedis() as any, makeDb(earlyColl), 'A_US_EQ', '5m', '30d', { asOf: k1 + 100 });
    expect(earlyBars).toHaveLength(1);
    expect(earlyBars[0].close).toBe(100);
    expect(earlyColl.aggregatePipelines).toHaveLength(1);

    const lateColl = makeCollectionWith(docs);
    const lateBars = await getBars(makeRedis() as any, makeDb(lateColl), 'A_US_EQ', '5m', '30d', { asOf: k2 + 100 });
    expect(lateBars).toHaveLength(1);
    expect(lateBars[0].close).toBe(101);
  });

  it('does not return revisions whose knowledge_ts is after asOf', async () => {
    const obsTs = _now - 1 * day;
    const k1 = _now - 1 * day + 60_000;
    const coll = makeCollectionWith([
      { symbol: 'A', market: 'US', observation_ts: obsTs, knowledge_ts: k1, interval: '5m', is_superseded: false, open: 1, high: 1, low: 1, close: 50, volume: 1 },
    ]);
    const bars = await getBars(makeRedis() as any, makeDb(coll), 'A_US_EQ', '5m', '30d', { asOf: k1 - 1 });
    expect(bars).toEqual([]);
  });
});

describe('cache key bucketing', () => {
  it('keys live and as-of reads under distinct entries', async () => {
    const coll = makeCollectionWith([]);
    const redis = makeRedis();
    await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d');
    await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d', { asOf: 1_700_000_000_000 });
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toContain('bars:v2:A:US:5m:30d:live');
    expect(setKeys).toContain('bars:v2:A:US:5m:30d:28333333');
    expect(new Set(setKeys).size).toBe(2);
  });

  it('shares a cache key across asOf values inside the same 60s bucket', async () => {
    const coll = makeCollectionWith([
      { symbol: 'A', market: 'US', observation_ts: 1, knowledge_ts: 1, interval: '5m', is_superseded: false, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ]);
    const redis = makeRedis();
    const base = 1_700_000_000_000;             // wall-clock ms inside an arbitrary minute
    await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d', { asOf: base });
    await getBars(redis as any, makeDb(coll), 'A_US_EQ', '5m', '30d', { asOf: base + 30_000 });
    // First call: Mongo + cache write. Second call: cache hit, no Mongo, no additional setEx.
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual([`bars:v2:A:US:5m:30d:${Math.floor(base / 60_000)}`]);
    // Second call should not aggregate again because the cache served it.
    expect(coll.aggregatePipelines).toHaveLength(1);
  });
});

describe('docToBar — schema compatibility', () => {
  it('reads the bi-temporal shape and re-derives the T212 ticker from (symbol, market)', async () => {
    const obs = _now - 1 * day;
    const know = _now - 1 * day + 60_000;
    const coll = makeCollectionWith([
      { symbol: 'A', market: 'US', observation_ts: obs, knowledge_ts: know, interval: '5m', is_superseded: false, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100, content_hash: 'abc' },
    ]);
    const bars = await getBars(makeRedis() as any, makeDb(coll), 'A_US_EQ', '5m', '30d');
    expect(bars).toHaveLength(1);
    // ticker is re-derived from (symbol, market) so OHLCVBar.ticker stays byte-identical.
    expect(bars[0].ticker).toBe('A_US_EQ');
    expect(bars[0].observation_ts).toBe(obs);
    expect(bars[0].knowledge_ts).toBe(know);
    expect(bars[0].is_superseded).toBe(false);
    expect(bars[0].content_hash).toBe('abc');
    // Legacy alias still populated for downstream readers.
    expect(bars[0].timestamp).toBe(obs);
  });

  it('reads an LSE row and re-derives the lowercase-l T212 form', async () => {
    const obs = _now - 1 * day;
    const coll = makeCollectionWith([
      { symbol: 'SHEL', market: 'LSE', observation_ts: obs, knowledge_ts: obs, is_superseded: false, interval: '5m', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ]);
    const bars = await getBars(makeRedis() as any, makeDb(coll), 'SHELl_EQ', '5m', '30d');
    expect(bars[0].ticker).toBe('SHELl_EQ');
    expect(bars[0].observation_ts).toBe(obs);

    // Sanity: an UNMIGRATED row with no observation_ts at all is invisible to the
    // bi-temporal live filter — by design. The stores are wiped + refetched at cutover.
    const unmigrated = makeCollectionWith([
      { symbol: 'SHEL', market: 'LSE', is_superseded: false, interval: '5m', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
    ]);
    const noObsBars = await getBars(makeRedis() as any, makeDb(unmigrated), 'SHELl_EQ', '5m', '30d');
    expect(noObsBars).toEqual([]);
  });
});
