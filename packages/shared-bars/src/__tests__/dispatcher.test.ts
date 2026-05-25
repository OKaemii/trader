// Tests for the BARS_BACKEND dispatcher in index.ts.
//
// Coverage:
//   • BARS_BACKEND default ('mongo' or unset) routes through the Mongo path
//     and writes the bars:v2:… cache key.
//   • BARS_BACKEND='timescale' routes through the PG path against a real
//     Timescale (testcontainers) and writes the bars:pg:v1:… cache key.
//   • Passing db=undefined with BARS_BACKEND=mongo throws — defensive guard.
//   • invalidateBars clears both namespaces unconditionally so dual-write
//     callers don't need to know which backend is active.
//
// The PG-side tests are gated by describe.skipIf(!dockerAvailable), matching the
// shared-pg / pg-bar-writer test pattern.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, invalidateBars } from '../index.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 120_000;

function makeRedis() {
  const store = new Map<string, string>();
  const calls: Array<{ op: 'get' | 'setEx' | 'del'; key: string }> = [];
  return {
    store, calls,
    get: async (key: string) => { calls.push({ op: 'get', key }); return store.get(key) ?? null; },
    setEx: async (key: string, _ttl: number, value: string) => {
      calls.push({ op: 'setEx', key });
      store.set(key, value);
      return 'OK' as const;
    },
    del: async (key: string) => {
      calls.push({ op: 'del', key });
      const had = store.has(key);
      store.delete(key);
      return had ? 1 : 0;
    },
  };
}

describe('BARS_BACKEND dispatcher — default (mongo)', () => {
  // Without `BARS_BACKEND` set, getBars must go through the Mongo path. We
  // pass a minimal mocked Db; if the dispatcher accidentally took the
  // Timescale branch the call would try to use getPgPool() and fail (or
  // succeed against a non-existent DB) — the assertion catches both.
  it('routes through the Mongo path when BARS_BACKEND is unset', async () => {
    delete process.env.BARS_BACKEND;
    const redis = makeRedis();
    const findCalls: Array<Record<string, unknown>> = [];
    const db = {
      collection: () => ({
        find: (filter: Record<string, unknown>) => {
          findCalls.push(filter);
          return { sort: () => ({ toArray: async () => [] }) };
        },
      }),
    } as unknown as import('mongodb').Db;

    await getBars(redis as unknown as Parameters<typeof getBars>[0], db, 'A', '5m', '30d');

    expect(findCalls).toHaveLength(1);
    expect(findCalls[0]).toMatchObject({ ticker: 'A', interval: '5m', is_superseded: false });
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual(['bars:v2:A:5m:30d:live']);
  });

  it('throws when db is undefined and BARS_BACKEND defaults to mongo', async () => {
    delete process.env.BARS_BACKEND;
    const redis = makeRedis();
    await expect(
      getBars(redis as unknown as Parameters<typeof getBars>[0], undefined, 'A', '5m', '30d'),
    ).rejects.toThrow(/db parameter required/);
  });
});

describe('invalidateBars — cross-namespace', () => {
  it('clears both Mongo and PG cache keys regardless of active backend', async () => {
    const redis = makeRedis();
    // Seed both namespaces.
    redis.store.set('bars:v2:A:5m:30d:live',     '{}');
    redis.store.set('bars:pg:v1:A:5m:30d:live',  '{}');
    redis.store.set('bars:v2:A:5m:60d:live',     '{}');
    redis.store.set('bars:pg:v1:A:5m:60d:live',  '{}');
    const removed = await invalidateBars(redis as unknown as Parameters<typeof invalidateBars>[0], 'A', '5m');
    // 4 cache rows + the meta key (not seeded but DEL'd anyway and counted as 0).
    expect(removed).toBe(4);
    expect(redis.store.size).toBe(0);
  });
});

describe.skipIf(!dockerAvailable)('BARS_BACKEND=timescale — real Postgres', () => {
  let container: StartedTestContainer;

  beforeAll(async () => {
    container = await new GenericContainer('timescale/timescaledb:2.17.2-pg16')
      .withEnvironment({
        POSTGRES_PASSWORD: 'test',
        POSTGRES_DB:       'trader_ts',
      })
      .withExposedPorts(5432)
      .withCommand(['postgres', '-c', "shared_preload_libraries=timescaledb"])
      .start();

    process.env.TIMESCALE_URL = `postgresql://postgres:test@${container.getHost()}:${container.getMappedPort(5432)}/trader_ts`;

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

  it('routes through the PG path when BARS_BACKEND=timescale and writes the bars:pg:v1:… cache key', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const pool = getPgPool();

    // Seed one bar directly so getBars has something to return.
    const obsTs = Date.now() - 24 * 60 * 60 * 1000;
    const knowTs = Date.now();
    await pool.query(
      `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                         open, high, low, close, volume,
                         raw_close, content_hash, is_superseded)
       VALUES ($1, $2, $3, '5m', 100, 101, 99, 100.5, 1000, 100.5, 'h', FALSE)`,
      ['A', obsTs, knowTs],
    );

    const redis = makeRedis();
    // db argument is irrelevant in the timescale path — pass undefined per the
    // new signature.
    const bars = await getBars(
      redis as unknown as Parameters<typeof getBars>[0],
      undefined,
      'A',
      '5m',
      '30d',
    );
    expect(bars).toHaveLength(1);
    expect(bars[0]?.close).toBe(100.5);
    expect(bars[0]?.observation_ts).toBe(obsTs);
    expect(bars[0]?.knowledge_ts).toBe(knowTs);

    // Cache key under the PG namespace, NOT the Mongo namespace.
    const setKeys = redis.calls.filter((c) => c.op === 'setEx').map((c) => c.key);
    expect(setKeys).toEqual(['bars:pg:v1:A:5m:30d:live']);
  }, TEST_TIMEOUT_MS);

  it('parametric: same call shape returns equivalent data on both backends for a fixed input', async () => {
    // Set up identical data in PG. (Mongo equivalence is covered by the
    // equivalence test in market-data-service tests/task 10; here we just lock
    // in that the PG path returns the bar shape consumers expect.)
    process.env.BARS_BACKEND = 'timescale';
    const pool = getPgPool();
    const obsTs = Date.now() - 24 * 60 * 60 * 1000;
    await pool.query(
      `INSERT INTO bars (ticker, observation_ts, knowledge_ts, interval,
                         open, high, low, close, volume,
                         raw_close, content_hash, is_superseded)
       VALUES ('B', $1, $2, '5m', 50, 51, 49, 50.5, 500, 50.5, 'h', FALSE)`,
      [obsTs, Date.now()],
    );

    const redis = makeRedis();
    const bars = await getBars(
      redis as unknown as Parameters<typeof getBars>[0],
      undefined,
      'B',
      '5m',
      '30d',
    );

    // Same OHLCVBar shape the Mongo path returns — fields and types match.
    expect(bars[0]).toMatchObject({
      ticker:         'B',
      observation_ts: obsTs,
      timestamp:      obsTs,
      interval:       '5m',
      open:  50,
      high:  51,
      low:   49,
      close: 50.5,
      volume: 500,
    });
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
