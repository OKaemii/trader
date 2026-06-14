// Bar-equivalence verification. Given a fixed input batch, the Mongo writer and
// the PG writer must produce semantically identical `getBars` outputs across
// both live (asOf undefined) and as-of (asOf set) read paths.
//
// This locks in the contract the operational verification job (running during
// the dual-write window per agent-docs/plans/three-database-split.md §Migration
// timeline) relies on: any mismatch between the two stores indicates a writer
// drift the cutover plan can't tolerate.
//
// Cases:
//   • Single first-print: Mongo and PG return the same bar.
//   • Multi-bar batch: array equality across both backends.
//   • Revision: live read returns the latest revision on both sides.
//   • As-of read: same revision picked on both sides given the same asOf.
//
// Run cost: one testcontainers Mongo (replica-set mode for transactions) +
// one testcontainers Timescale. Gated by docker availability.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePgPool, getPgPool, runMigrations } from '@trader/shared-pg';
import { getMongoClient, getMongoDb } from '@trader/shared-mongo';
import { aggregateBars, getBars, getBarsFromPg } from '@trader/shared-bars';
import type { OHLCVBar } from '@trader/shared-types';
import { writeBarRevisions, ensureBiTemporalIndexes } from '../modules/bars/infrastructure/persist-bars.ts';
import { writeBarRevisionsPg } from '../modules/bars/infrastructure/pg-bar-writer.ts';

const dockerAvailable = await isDockerAvailable();
const TEST_TIMEOUT_MS = 180_000;

function makeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string) => store.get(key) ?? null,
    setEx: async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK' as const;
    },
  };
}

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

// Normalise both backends' OHLCVBar output to a comparable shape. Mongo's
// docToBar populates `is_superseded:false` only when the document has it set;
// PG's rowToBar always populates it (column is NOT NULL). Comparing strict
// equality would diverge on that one field even though the live-read contract
// is identical. Strip both before compare.
function normalise(b: OHLCVBar): Record<string, unknown> {
  const { is_superseded, content_hash, knowledge_ts, currency, ...rest } = b;
  return rest;
}

describe.skipIf(!dockerAvailable)('bar-equivalence (Mongo vs Timescale)', () => {
  let mongoContainer: StartedTestContainer;
  let tsContainer: StartedTestContainer;

  beforeAll(async () => {
    // Spin up both DBs in parallel — independent.
    [mongoContainer, tsContainer] = await Promise.all([
      new GenericContainer('mongo:6')
        .withExposedPorts(27017)
        .withCommand(['mongod', '--replSet', 'rs0', '--bind_ip_all'])
        .withWaitStrategy(Wait.forLogMessage(/Waiting for connections/))
        .start(),
      new GenericContainer('timescale/timescaledb:2.17.2-pg16')
        .withEnvironment({
          POSTGRES_PASSWORD: 'test',
          POSTGRES_DB:       'trader_ts',
        })
        .withExposedPorts(5432)
        .withCommand(['postgres', '-c', "shared_preload_libraries=timescaledb"])
        .start(),
    ]);

    // Set MONGODB_URL before any call to getMongoClient — the shared-mongo
    // singleton lazy-initialises from this env on first call.
    process.env.MONGODB_URL = `mongodb://${mongoContainer.getHost()}:${mongoContainer.getMappedPort(27017)}/?directConnection=true`;

    // rs.initiate for transaction support, via the SAME singleton client the
    // writer will use. Critical: writeBarRevisions's `client.startSession()`
    // returns a session bound to the singleton — if our test used a separate
    // MongoClient, the session would error with "ClientSession must be from
    // the same MongoClient" on the first transaction. Using the singleton
    // throughout ensures the session matches the collection.
    //
    // Member host is "127.0.0.1:27017" (how the container sees itself), not
    // the mapped host port. External clients use directConnection=true so they
    // don't try to follow the member list back to the unreachable internal addr.
    const client = await getMongoClient();
    const adminDb = client.db('admin');
    await adminDb.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: '127.0.0.1:27017' }],
      },
    });
    // Wait for PRIMARY election (rs.initiate is async).
    for (let attempt = 0; attempt < 20; attempt++) {
      const status = await adminDb.command({ replSetGetStatus: 1 }).catch(() => null);
      const primary = (status as { members?: Array<{ stateStr?: string }> } | null)?.members?.find((m) => m.stateStr === 'PRIMARY');
      if (primary) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    // Single-node rs sometimes still needs another moment before writes succeed.
    await new Promise((r) => setTimeout(r, 500));

    // Mongo indexes mirror the live deployment's state.
    const mongoDb = await getMongoDb('trader');
    await ensureBiTemporalIndexes(mongoDb);

    // PG: enable extension, run migrations.
    process.env.TIMESCALE_URL = `postgresql://postgres:test@${tsContainer.getHost()}:${tsContainer.getMappedPort(5432)}/trader_ts`;
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
    const client = await getMongoClient().catch(() => null);
    await client?.close();
    await closePgPool();
    await Promise.all([mongoContainer?.stop(), tsContainer?.stop()].filter(Boolean));
    delete process.env.MONGODB_URL;
    delete process.env.TIMESCALE_URL;
  }, TEST_TIMEOUT_MS);

  beforeEach(async () => {
    // Default backend for the parity tests (writeBarRevisions is expected Mongo-primary here); the
    // dispatch round-trip tests set BARS_BACKEND themselves and restore it.
    delete process.env.BARS_BACKEND;
    delete process.env.DUAL_WRITE_BARS;
    // Wipe both stores.
    const mongoDb = await getMongoDb('trader');
    await mongoDb.collection('ohlcv_bars').deleteMany({});
    await mongoDb.collection('bar_revisions_log').deleteMany({});
    const pool = getPgPool();
    await pool.query('TRUNCATE bars, bar_revisions_log');
  });

  // Realistic observation_ts values: getBars filters to `observation_ts >= now -
  // RANGE_DAYS * 24h`. Cheap arbitrary fixed-1970 timestamps would all sit below
  // that cutoff and silently produce empty arrays — a false-positive trap when
  // comparing "[] === []" across backends.
  const DAY_MS  = 24 * 60 * 60 * 1000;
  const OBS_A_1 = Date.now() - 10 * DAY_MS;   // 10 days ago
  const OBS_A_2 = Date.now() - 9  * DAY_MS;
  const OBS_B_1 = Date.now() - 8  * DAY_MS;
  const OBS_B_2 = Date.now() - 7  * DAY_MS;

  it('first-print: both backends return the same bar', async () => {
    const mongoDb = await getMongoDb('trader');
    const b = bar('A_US_EQ', OBS_A_1, 100);
    const now = Date.now();

    await writeBarRevisions(mongoDb, [b], '5m', now);
    await writeBarRevisionsPg([b], '5m', now);

    const redisMongo = makeRedis();
    const redisPg = makeRedis();
    const mongoBars = await getBars(redisMongo as never, mongoDb, 'A_US_EQ', '5m', '180d');
    const pgBars    = await getBarsFromPg(redisPg as never, 'A_US_EQ', '5m', '180d');

    expect(mongoBars).toHaveLength(1);
    expect(pgBars).toHaveLength(1);
    expect(normalise(mongoBars[0]!)).toEqual(normalise(pgBars[0]!));
  }, TEST_TIMEOUT_MS);

  it('multi-bar batch: arrays equal across backends', async () => {
    const mongoDb = await getMongoDb('trader');
    const bars: OHLCVBar[] = [
      bar('A_US_EQ', OBS_A_1, 100),
      bar('A_US_EQ', OBS_A_2, 200),
      bar('B_US_EQ', OBS_B_1, 50),
      bar('B_US_EQ', OBS_B_2, 60),
    ];
    await writeBarRevisions(mongoDb, bars, '5m');
    await writeBarRevisionsPg(bars, '5m');

    for (const ticker of ['A_US_EQ', 'B_US_EQ'] as const) {
      const mongoBars = await getBars(makeRedis() as never, mongoDb, ticker, '5m', '180d');
      const pgBars    = await getBarsFromPg(makeRedis() as never, ticker, '5m', '180d');
      // Both non-empty AND equal — guards against the empty-equals-empty false positive.
      expect(mongoBars.length).toBeGreaterThan(0);
      expect(mongoBars.map(normalise)).toEqual(pgBars.map(normalise));
    }
  }, TEST_TIMEOUT_MS);

  it('revision: live read returns the latest revision on both sides', async () => {
    const mongoDb = await getMongoDb('trader');
    const original = bar('A_US_EQ', OBS_A_1, 100);
    const revised  = bar('A_US_EQ', OBS_A_1, 101);
    const t0 = Date.now();
    const t1 = t0 + 1_000;

    // First print and revision in both stores.
    await writeBarRevisions(mongoDb, [original], '5m', t0);
    await writeBarRevisionsPg([original],         '5m', t0);
    await writeBarRevisions(mongoDb, [revised],   '5m', t1);
    await writeBarRevisionsPg([revised],          '5m', t1);

    const mongoBars = await getBars(makeRedis() as never, mongoDb, 'A_US_EQ', '5m', '180d');
    const pgBars    = await getBarsFromPg(makeRedis() as never, 'A_US_EQ', '5m', '180d');

    expect(mongoBars).toHaveLength(1);
    expect(pgBars).toHaveLength(1);
    expect(mongoBars[0]?.close).toBe(101);
    expect(pgBars[0]?.close).toBe(101);
    expect(normalise(mongoBars[0]!)).toEqual(normalise(pgBars[0]!));

    // Sanity — the prior revision is still in both stores, just superseded.
    const mongoCount = await mongoDb.collection('ohlcv_bars').countDocuments({ symbol: 'A', market: 'US' });
    const { rows } = await getPgPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM bars WHERE symbol = 'A' AND market = 'US'",
    );
    expect(mongoCount).toBe(2);
    expect(rows[0]?.n).toBe(2);
  }, TEST_TIMEOUT_MS);

  it('as-of read: same revision picked on both sides given the same asOf', async () => {
    const mongoDb = await getMongoDb('trader');
    const original = bar('A_US_EQ', OBS_A_1, 100);
    const revised  = bar('A_US_EQ', OBS_A_1, 101);
    const t0 = Date.now();
    const t1 = t0 + 1_000;

    await writeBarRevisions(mongoDb, [original], '5m', t0);
    await writeBarRevisionsPg([original],         '5m', t0);
    await writeBarRevisions(mongoDb, [revised],   '5m', t1);
    await writeBarRevisionsPg([revised],          '5m', t1);

    // asOf in the middle of the two writes: both backends should pick the t0 revision.
    const asOfMid = t0 + 500;
    const mongoMidBars = await getBars(makeRedis() as never, mongoDb, 'A_US_EQ', '5m', '180d', { asOf: asOfMid });
    const pgMidBars    = await getBarsFromPg(makeRedis() as never, 'A_US_EQ', '5m', '180d', { asOf: asOfMid });
    expect(mongoMidBars).toHaveLength(1);
    expect(pgMidBars).toHaveLength(1);
    expect(mongoMidBars[0]?.close).toBe(100);
    expect(pgMidBars[0]?.close).toBe(100);
    expect(normalise(mongoMidBars[0]!)).toEqual(normalise(pgMidBars[0]!));

    // asOf after t1: both should pick the revised.
    const asOfAfter = t1 + 500;
    const mongoAfterBars = await getBars(makeRedis() as never, mongoDb, 'A_US_EQ', '5m', '180d', { asOf: asOfAfter });
    const pgAfterBars    = await getBarsFromPg(makeRedis() as never, 'A_US_EQ', '5m', '180d', { asOf: asOfAfter });
    expect(mongoAfterBars[0]?.close).toBe(101);
    expect(pgAfterBars[0]?.close).toBe(101);
  }, TEST_TIMEOUT_MS);

  it('aggregateBars on either backend yields the same daily candle', async () => {
    // 5m bars across a day on both backends → aggregateBars('daily') must yield
    // the same single OHLC summary. This is the consumer-side path
    // (factor_rank_strategy, dispatcher drift gate).
    const mongoDb = await getMongoDb('trader');
    // 5 days ago, 00:00 UTC. Within the 180d window.
    const dayStartMs = Math.floor((Date.now() - 5 * DAY_MS) / DAY_MS) * DAY_MS;
    const fiveMinMs  = 5 * 60 * 1000;
    const bars: OHLCVBar[] = [];
    for (let i = 0; i < 4; i++) {
      bars.push(bar('A_US_EQ', dayStartMs + i * fiveMinMs, 100 + i));
    }
    await writeBarRevisions(mongoDb, bars, '5m');
    await writeBarRevisionsPg(bars, '5m');

    const mongoBars = await getBars(makeRedis() as never, mongoDb, 'A_US_EQ', '5m', '180d');
    const pgBars    = await getBarsFromPg(makeRedis() as never, 'A_US_EQ', '5m', '180d');
    const mongoDaily = aggregateBars(mongoBars, 'daily');
    const pgDaily    = aggregateBars(pgBars, 'daily');

    expect(mongoDaily.map(normalise)).toEqual(pgDaily.map(normalise));
    expect(mongoDaily[0]?.open).toBe(100);
    expect(mongoDaily[0]?.close).toBe(103);
    expect(mongoDaily[0]?.high).toBe(103.5);
    expect(mongoDaily[0]?.low).toBe(99.5);
  }, TEST_TIMEOUT_MS);

  // The store-inversion fix end-to-end: under BARS_BACKEND=timescale the DISPATCHED writer
  // (writeBarRevisions, not writeBarRevisionsPg) lands bars in Timescale and NOT Mongo, and the
  // DISPATCHED reader (getBars, db=undefined) reads them back from the SAME store. This is the
  // round-trip the live config runs: write store == read store. Pre-fix the writer was Mongo-primary
  // so this read-back returned nothing (the bug).
  it('BARS_BACKEND=timescale: dispatched write → dispatched read round-trips through Timescale only', async () => {
    const mongoDb = await getMongoDb('trader');
    const prev = process.env.BARS_BACKEND;
    process.env.BARS_BACKEND = 'timescale';
    try {
      const obs = OBS_A_1;
      const b = bar('A_US_EQ', obs, 140);
      // The DISPATCHER decides the store — pass the Mongo db, but timescale routing must ignore it
      // for the write (Timescale-primary, DUAL_WRITE_BARS unset).
      delete process.env.DUAL_WRITE_BARS;
      await writeBarRevisions(mongoDb, [b], '5m');

      // Read back through the DISPATCHER (db=undefined is legal on the timescale path).
      const readBack = await getBars(makeRedis() as never, undefined, 'A_US_EQ', '5m', '180d');
      expect(readBack).toHaveLength(1);
      expect(readBack[0]?.close).toBe(140);
      expect(readBack[0]?.observation_ts).toBe(obs);

      // Landed in Timescale…
      const { rows } = await getPgPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM bars WHERE symbol = 'A' AND market = 'US' AND interval = '5m'",
      );
      expect(rows[0]?.n).toBe(1);
      // …and NOT in Mongo (the inversion is fixed — no Mongo-only write stranded).
      const mongoCount = await mongoDb.collection('ohlcv_bars').countDocuments({ symbol: 'A', market: 'US', interval: '5m' });
      expect(mongoCount).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BARS_BACKEND; else process.env.BARS_BACKEND = prev;
    }
  }, TEST_TIMEOUT_MS);

  // The rollback path stays whole: BARS_BACKEND=timescale + DUAL_WRITE_BARS=true writes BOTH stores
  // (Timescale primary + the Mongo rollback mirror), so flipping BARS_BACKEND back to mongo finds the
  // bars already present.
  it('BARS_BACKEND=timescale + DUAL_WRITE_BARS=true: writes BOTH stores (rollback mirror intact)', async () => {
    const mongoDb = await getMongoDb('trader');
    const prevBackend = process.env.BARS_BACKEND;
    const prevDual = process.env.DUAL_WRITE_BARS;
    process.env.BARS_BACKEND = 'timescale';
    process.env.DUAL_WRITE_BARS = 'true';
    try {
      const b = bar('B_US_EQ', OBS_B_1, 77);
      await writeBarRevisions(mongoDb, [b], '5m');

      const { rows } = await getPgPool().query<{ n: number }>(
        "SELECT count(*)::int AS n FROM bars WHERE symbol = 'B' AND market = 'US' AND interval = '5m'",
      );
      expect(rows[0]?.n).toBe(1);                                       // Timescale (primary)
      const mongoCount = await mongoDb.collection('ohlcv_bars').countDocuments({ symbol: 'B', market: 'US', interval: '5m' });
      expect(mongoCount).toBe(1);                                       // Mongo (rollback mirror)
    } finally {
      if (prevBackend === undefined) delete process.env.BARS_BACKEND; else process.env.BARS_BACKEND = prevBackend;
      if (prevDual === undefined) delete process.env.DUAL_WRITE_BARS; else process.env.DUAL_WRITE_BARS = prevDual;
    }
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
