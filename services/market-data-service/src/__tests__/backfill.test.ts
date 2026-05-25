// Tests the backfill -> writeBarRevisions integration. The pre-bi-temporal version of
// this file tested mongo bulkWrite counter shapes; that drift-prone math is gone now —
// the writer reports `inserted` directly. The remaining concern is that backfillOne
// (a) hands every fetched bar to writeBarRevisions, (b) returns the right `upserted`
// count for the admin/portal display, and (c) never inflates the count on empty input.

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, vi } from "vitest";
import { backfillTickers } from '../modules/bars/infrastructure/backfill.ts';
import type { MarketDataProvider } from '../modules/bars/infrastructure/providers/market-data-provider.ts';
import type { OHLCVBar, PollIntervalKey } from '@trader/shared-types';

// Stub writeBarRevisions so the tests don't touch real Mongo. Same module surface,
// returns controllable stats. Vitest hoists vi.mock above imports so the alias has to
// be registered with the same relative path the implementation uses.
vi.mock('../modules/bars/infrastructure/persist-bars.ts', () => ({
  writeBarRevisions: vi.fn(async (_db: unknown, bars: OHLCVBar[]) => ({
    attempted: bars.length,
    inserted:  bars.length,        // pretend every bar was a fresh insert
    revisions: 0,
    skipped:   0,
  })),
  ensureBiTemporalIndexes: vi.fn(async () => {}),
}));

function bar(ticker: string, ts: number): OHLCVBar {
  return {
    ticker,
    observation_ts: ts,
    timestamp:      ts,
    interval: '5m',
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

// Minimal Mongo Db stub — writeBarRevisions is mocked, so this only needs the surface
// that backfillTickers itself touches (none, in practice). Cast to `any` to avoid
// pulling in the full mongodb types.
const stubDb = { collection: () => ({}) } as any;

const stubRedis = {
  del:     async () => 0,
  publish: async () => 0,
} as any;

describe('backfillTickers → writeBarRevisions', () => {
  it('reports `upserted` matching writeBarRevisions.inserted on a fresh write', async () => {
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000), bar('A', 3000)]);
    const results = await backfillTickers(stubDb, stubRedis, provider, ['A']);
    expect(results[0].fetched).toBe(3);
    expect(results[0].upserted).toBe(3);
  });

  it('reports `upserted` = 0 when nothing was inserted but nothing was skipped (empty fetch)', async () => {
    // Empty provider response → writeBarRevisions is never invoked, fetched = 0.
    const provider = new StubProvider([]);
    const results = await backfillTickers(stubDb, stubRedis, provider, ['A']);
    expect(results[0].fetched).toBe(0);
    expect(results[0].upserted).toBe(0);
  });

  it('isolates failures per ticker — one error does not poison the batch', async () => {
    const failing = new StubProvider([]) as unknown as MarketDataProvider;
    // Override fetchHistory to throw, simulating provider unavailability.
    (failing as { fetchHistory: () => Promise<OHLCVBar[]> }).fetchHistory = async () => { throw new Error('upstream down'); };

    const results = await backfillTickers(stubDb, stubRedis, failing, ['A', 'B']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error?.includes('upstream down'))).toBe(true);
    expect(results.every((r) => r.upserted === 0)).toBe(true);
  });
});
