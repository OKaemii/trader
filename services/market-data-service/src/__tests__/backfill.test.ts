// Tests the backfill upserted-counter math. Regression for the deploy-time bug where
// a 421k-row bootstrap reported "0 bars upserted" because we summed only
// upsertedCount + modifiedCount — but Mongo distributes upsert successes across
// upsertedCount / insertedCount / modifiedCount / upsertedIds depending on driver
// version + collection options. The fix sums all of them AND falls back to ops.length
// if every counter is zero.

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect } from "vitest";
import { backfillTickers } from '../modules/bars/infrastructure/backfill.ts';
import type { MarketDataProvider } from '../modules/bars/infrastructure/providers/market-data-provider.ts';
import type { OHLCVBar, PollIntervalKey } from '@trader/shared-types';

function bar(ticker: string, ts: number): OHLCVBar {
  return {
    ticker, timestamp: ts, interval: '5m',
    open: 100, high: 100, low: 100, close: 100, volume: 1,
  };
}

class StubProvider implements MarketDataProvider {
  readonly name = 'stub';
  readonly maxLookbackMs = 60 * 24 * 60 * 60_000;
  readonly allowedPollIntervals: readonly PollIntervalKey[] = ['1h'];
  constructor(private barsToReturn: OHLCVBar[]) {}
  async fetchLatest() { return []; }
  async fetchRecent() { return []; }
  async fetchHistory() { return this.barsToReturn; }
  async fetchLiquidity() { return {}; }
}

// In-memory Mongo Db stub with just enough surface for backfillTickers.
function makeDb(bulkWriteResult: any) {
  const ops: any[] = [];
  return {
    collection: () => ({
      bulkWrite: async (opsArg: any[]) => {
        ops.push(...opsArg);
        return bulkWriteResult;
      },
      insertOne: async () => ({}),
    }),
    _ops: ops,
  } as any;
}

const stubRedis = {
  del:     async () => 0,
  publish: async () => 0,
} as any;

describe('backfillTickers upserted counter', () => {
  it('reports correct count when result.upsertedCount is set (fresh-write case)', async () => {
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000), bar('A', 3000)]);
    const db = makeDb({ upsertedCount: 3, insertedCount: 0, modifiedCount: 0, upsertedIds: {} });
    const results = await backfillTickers(db, stubRedis, provider, ['A']);
    expect(results[0].upserted).toBeGreaterThanOrEqual(3);
  });

  it('reports correct count when result.modifiedCount is set (re-run case)', async () => {
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000)]);
    const db = makeDb({ upsertedCount: 0, modifiedCount: 2, upsertedIds: {} });
    const results = await backfillTickers(db, stubRedis, provider, ['A']);
    expect(results[0].upserted).toBeGreaterThanOrEqual(2);
  });

  it('falls back to ops.length when all counters are zero (driver-specific case)', async () => {
    // The bug: some Mongo driver / collection combinations return ALL zeros even
    // when 400k+ rows were created. Without the fallback we'd report "0 upserted"
    // and the bootstrap log would lie. Verify the fallback kicks in.
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000), bar('A', 3000)]);
    const db = makeDb({ upsertedCount: 0, modifiedCount: 0, insertedCount: 0, upsertedIds: {} });
    const results = await backfillTickers(db, stubRedis, provider, ['A']);
    expect(results[0].upserted).toBe(3);
  });

  it('reports 0 when no bars were fetched (no fallback inflation)', async () => {
    // The fallback should NOT report ops.length when there were no ops to begin with.
    const provider = new StubProvider([]);
    const db = makeDb({ upsertedCount: 0, modifiedCount: 0 });
    const results = await backfillTickers(db, stubRedis, provider, ['A']);
    expect(results[0].fetched).toBe(0);
    expect(results[0].upserted).toBe(0);
  });

  it('uses upsertedIds key count when other counters are zero', async () => {
    // Real-world: some bulkWrite results populate upsertedIds (a map of position → _id)
    // for inserts but leave upsertedCount at 0. Cover that path explicitly.
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000)]);
    const db = makeDb({ upsertedCount: 0, modifiedCount: 0, upsertedIds: { 0: 'id1', 1: 'id2' } });
    const results = await backfillTickers(db, stubRedis, provider, ['A']);
    expect(results[0].upserted).toBeGreaterThanOrEqual(2);
  });
});
