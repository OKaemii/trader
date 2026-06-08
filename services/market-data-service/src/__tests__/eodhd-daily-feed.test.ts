// EODHD bulk daily feed — the pure mapping core (buildEodhdFeedBars) plus the orchestration hook that
// runs the corporate-actions sync AFTER the bulk-EOD pull (plan §8 Gap 1, Task 10). The pure mapping
// locks in the active-universe filtering + currency scaling; the orchestration test asserts the
// corporate-actions pass is invoked over the active universe once the bulk loop completes.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';
import type { Db } from 'mongodb';
import { buildEodhdFeedBars, runEodhdDailyFeed, type CorporateActionsSync } from '../modules/bars/infrastructure/eodhd-daily-feed.ts';
import { EodhdClient, _setEodhdClientForTest, type EodhdBulkRow } from '../modules/bars/infrastructure/providers/eodhd-client.ts';
import { invalidateBars } from '@trader/shared-bars';
import type * as SharedBars from '@trader/shared-bars';

vi.mock('@trader/shared-bars', async () => {
  const actual = await vi.importActual<typeof SharedBars>('@trader/shared-bars');
  return { ...actual, invalidateBars: vi.fn(async () => {}) };
});

const rows: EodhdBulkRow[] = [
  { code: 'AAPL',    date: '2026-06-01', open: 200, high: 205, low: 199, close: 200, adjusted_close: 200, volume: 1e6 },
  { code: 'HSBA',    date: '2026-06-01', open: 870, high: 875, low: 865, close: 870, adjusted_close: 870, volume: 5e5 },
  { code: 'NOTHELD', date: '2026-06-01', open: 1,   high: 1,   low: 1,   close: 1,   adjusted_close: 1,   volume: 1 },
];

describe('buildEodhdFeedBars', () => {
  it('maps only active-universe names for the requested exchange, scaling pence on LSE', () => {
    const usBars = buildEodhdFeedBars(rows, 'US', ['AAPL_US_EQ', 'HSBAl_EQ']);
    expect(usBars.map((b) => b.ticker)).toEqual(['AAPL_US_EQ']);   // HSBA is LSE; NOTHELD not held
    expect(usBars[0]!.currency).toBe('USD');
    expect(usBars[0]!.close).toBe(200);
    expect(usBars[0]!.interval).toBe('daily');
    expect(usBars[0]!.observation_ts).toBe(Date.parse('2026-06-01T00:00:00Z'));

    const lseBars = buildEodhdFeedBars(rows, 'LSE', ['AAPL_US_EQ', 'HSBAl_EQ']);
    expect(lseBars.map((b) => b.ticker)).toEqual(['HSBAl_EQ']);
    expect(lseBars[0]!.currency).toBe('GBP');
    expect(lseBars[0]!.close).toBeCloseTo(8.70, 6);                 // pence → pounds
  });

  it('returns [] when no active ticker matches the exchange', () => {
    expect(buildEodhdFeedBars(rows, 'US', ['HSBAl_EQ'])).toEqual([]);
  });
});

// ── Orchestration: the corporate-actions pass runs after the bulk-EOD pull (Gap 1) ───────────────
// An EodhdClient whose bulkLastDay returns no rows lets us drive runEodhdDailyFeed through the gate +
// bulk-empty branch (no Mongo write) and still reach the post-loop corporate-actions block — so we
// assert the sync is invoked over the active universe without standing up Mongo/writeBarRevisions.
class EmptyBulkEodhdClient extends EodhdClient {
  constructor() { super({ apiKey: 'k' }); }
  override async bulkLastDay(): Promise<EodhdBulkRow[]> { return []; }
}

// Minimal Redis surface runEodhdDailyFeed touches: NX gate set, del (gate release on empty), publish.
function fakeRedis(): RedisClientType {
  return {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
    publish: vi.fn(async () => 0),
  } as unknown as RedisClientType;
}

const fakeDb = {} as unknown as Db;

describe('runEodhdDailyFeed — corporate-actions pass (Gap 1)', () => {
  afterEach(() => { _setEodhdClientForTest(null); vi.clearAllMocks(); });

  it('invokes the corporate-actions sync over the active universe after the bulk pull', async () => {
    _setEodhdClientForTest(new EmptyBulkEodhdClient());
    const syncMany = vi.fn(async (tickers: string[]) => ({ tickers: tickers.length, fetched: 0, newDividends: 0, newSplits: 0 }));
    const ca: CorporateActionsSync = { syncMany };

    await runEodhdDailyFeed(fakeDb, fakeRedis(), ['AAPL_US_EQ', 'HSBAl_EQ'], ca);

    expect(syncMany).toHaveBeenCalledTimes(1);
    expect(syncMany.mock.calls[0]![0]).toEqual(['AAPL_US_EQ', 'HSBAl_EQ']);   // whole active universe
  });

  it('runs unchanged (no throw) when no corporate-actions sync is supplied — back-compatible', async () => {
    _setEodhdClientForTest(new EmptyBulkEodhdClient());
    await expect(runEodhdDailyFeed(fakeDb, fakeRedis(), ['AAPL_US_EQ'])).resolves.toBeDefined();
    expect(invalidateBars).not.toHaveBeenCalled();   // empty bulk ⇒ nothing persisted/invalidated
  });

  it('a failing corporate-actions sync does not fail the feed (best-effort)', async () => {
    _setEodhdClientForTest(new EmptyBulkEodhdClient());
    const ca: CorporateActionsSync = { syncMany: vi.fn(async () => { throw new Error('eodhd budget gone'); }) };
    // The bulk write already succeeded (here: empty) — a corporate-actions failure must not propagate.
    await expect(runEodhdDailyFeed(fakeDb, fakeRedis(), ['AAPL_US_EQ'], ca)).resolves.toBeDefined();
  });
});
