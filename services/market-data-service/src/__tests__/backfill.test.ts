// Tests the backfill -> writeBarRevisions integration AND the gap-aware FETCH planning
// (Task 16, §I). The pre-bi-temporal version of this file tested mongo bulkWrite counter
// shapes; that drift-prone math is gone — the writer reports `inserted` directly.
//
// Two concerns now:
//   1. backfillOne (a) hands every fetched bar to writeBarRevisions, (b) returns the right
//      `upserted` count for the admin/portal display, and (c) never inflates on empty input.
//   2. Gap-aware fetch: before fetching, compute the observation_ts sub-ranges we don't hold
//      and fetch ONLY those. Full coverage ⇒ ZERO upstream calls; interior + tail gaps are
//      fetched; `forceRefetch` re-downloads the whole window. This is the biggest EODHD-credit
//      saver in the epic, so the gap math is guarded directly here.

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

const FIVE_MIN_MS = 5 * 60_000;

function bar(ticker: string, ts: number): OHLCVBar {
  return {
    ticker,
    observation_ts: ts,
    timestamp:      ts,
    interval: '5m',
    open: 100, high: 100, low: 100, close: 100, volume: 1,
  };
}

// A provider whose fetchHistory returns one 5m bar per grid point inside [startTs, endTs),
// and records every (startTs, endTs) it was asked for. Lets a test both assert how many
// upstream calls happened AND feed realistic bars back to the writer.
class RecordingProvider implements MarketDataProvider {
  readonly name = 'rec';
  readonly maxLookbackMs = 60 * 24 * 60 * 60_000;
  readonly allowedPollIntervals: readonly PollIntervalKey[] = ['1h'];
  readonly calls: Array<{ startTs: number; endTs: number }> = [];
  constructor(private readonly ticker = 'A') {}
  async fetchLatest() { return []; }
  async fetchRecent() { return []; }
  async fetchHistory(_t: string, startTs: number, endTs: number) {
    this.calls.push({ startTs, endTs });
    const bars: OHLCVBar[] = [];
    for (let ts = startTs; ts < endTs; ts += FIVE_MIN_MS) bars.push(bar(this.ticker, ts));
    return bars;
  }
  async fetchLiquidity() { return {}; }
}

// Legacy-style stub for the writer/error tests: returns a fixed bar list regardless of window.
class StubProvider implements MarketDataProvider {
  readonly name = 'stub';
  readonly maxLookbackMs = 60 * 24 * 60 * 60_000;
  readonly allowedPollIntervals: readonly PollIntervalKey[] = ['1h'];
  readonly calls: Array<{ startTs: number; endTs: number }> = [];
  constructor(private barsToReturn: OHLCVBar[]) {}
  async fetchLatest() { return []; }
  async fetchRecent() { return []; }
  async fetchHistory(_t: string, startTs: number, endTs: number) {
    this.calls.push({ startTs, endTs });
    return this.barsToReturn;
  }
  async fetchLiquidity() { return {}; }
}

// Mongo Db stub whose ohlcv_bars `find().toArray()` returns the supplied observed
// observation_ts (as the projection { observation_ts } docs). The gap-aware planner reads
// exactly this surface; `observed: []` ⇒ "nothing held" ⇒ whole-span fetch.
function dbWithObserved(observed: number[]) {
  return {
    collection: () => ({
      find: () => ({
        toArray: async () => observed.map((ts) => ({ observation_ts: ts })),
      }),
    }),
  } as any;
}

const stubRedis = {
  del:     async () => 0,
  publish: async () => 0,
} as any;

describe('backfillTickers → writeBarRevisions', () => {
  it('reports `upserted` matching writeBarRevisions.inserted on a fresh write', async () => {
    // Empty store ⇒ whole span is a gap ⇒ provider returns its 3 bars.
    const provider = new StubProvider([bar('A', 1000), bar('A', 2000), bar('A', 3000)]);
    const results = await backfillTickers(dbWithObserved([]), stubRedis, provider, ['A']);
    expect(results[0].fetched).toBe(3);
    expect(results[0].upserted).toBe(3);
  });

  it('reports `upserted` = 0 when the provider yields nothing for the gap', async () => {
    const provider = new StubProvider([]);
    const results = await backfillTickers(dbWithObserved([]), stubRedis, provider, ['A']);
    expect(results[0].fetched).toBe(0);
    expect(results[0].upserted).toBe(0);
  });

  it('isolates failures per ticker — one error does not poison the batch', async () => {
    const failing = new StubProvider([]) as unknown as MarketDataProvider;
    // Override fetchHistory to throw, simulating provider unavailability.
    (failing as { fetchHistory: () => Promise<OHLCVBar[]> }).fetchHistory = async () => { throw new Error('upstream down'); };

    const results = await backfillTickers(dbWithObserved([]), stubRedis, failing, ['A', 'B']);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error?.includes('upstream down'))).toBe(true);
    expect(results.every((r) => r.upserted === 0)).toBe(true);
  });
});

describe('backfillTickers — gap-aware fetch (§I)', () => {
  // A small, grid-aligned 5m window so the planner's grid points line up with the held bars.
  // endTs is exclusive of the last grid point in computeMissingRanges terms; we floor to the
  // 5m grid in the helper, so picking grid-aligned bounds keeps the math exact.
  const STEP = FIVE_MIN_MS;
  const windowMs = 6 * STEP;           // 6 grid points: p0..p5 (p6 == endTs, excluded)

  it('FULL coverage → ZERO upstream calls / zero credits', async () => {
    // Hold every grid point the planner will visit. backfillTickers anchors endTs at now and
    // startTs at now-window; we can't predict `now`, so instead make a window so small the
    // floor-to-grid leaves exactly the held points covered. We hold a dense 5m series across a
    // wide span centred on now via a generated set computed from Date.now().
    const now = Date.now();
    const flooredEnd = Math.floor(now / STEP) * STEP;
    const flooredStart = Math.floor((now - windowMs) / STEP) * STEP;
    const observed: number[] = [];
    for (let ts = flooredStart; ts <= flooredEnd; ts += STEP) observed.push(ts);

    const provider = new RecordingProvider('A');
    const results = await backfillTickers(dbWithObserved(observed), stubRedis, provider, ['A'], { windowMs });

    expect(provider.calls).toHaveLength(0);   // ← the load-bearing assertion: no fetch when covered
    expect(results[0].fetched).toBe(0);
    expect(results[0].upserted).toBe(0);
  });

  it('TAIL gap → fetches only the uncovered trailing span (> the overnight bridge)', async () => {
    // Hold the older portion densely; leave the most recent full day (> the 18h intraday
    // bridge) uncovered. The planner must fetch a single trailing window starting in the
    // recent tail, not the whole span — and the tail must survive the closure bridge.
    const oneDay = 24 * 60 * 60_000;
    const bigWindow = 3 * oneDay;
    const now = Date.now();
    const flooredEnd = Math.floor(now / STEP) * STEP;
    const flooredStart = Math.floor((now - bigWindow) / STEP) * STEP;
    const cutoff = flooredEnd - oneDay;           // last day missing
    const observed: number[] = [];
    for (let ts = flooredStart; ts <= cutoff; ts += STEP) observed.push(ts);

    const provider = new RecordingProvider('A');
    const results = await backfillTickers(dbWithObserved(observed), stubRedis, provider, ['A'], { windowMs: bigWindow });

    expect(provider.calls).toHaveLength(1);
    // Fetch starts at the first uncovered grid point (cutoff+STEP), in the recent tail.
    expect(provider.calls[0].startTs).toBe(cutoff + STEP);
    expect(results[0].fetched).toBeGreaterThan(0);
  });

  it('INTERIOR gap → fetches only the genuine missing run (overnight holes bridged)', async () => {
    // Hold both ends of the window but punch out a wide middle run (> the 18h intraday bridge),
    // which is a genuine missing span, not an overnight close. Only that interior window is
    // fetched. Use a window large enough that the interior hole exceeds 18h.
    const STEP_L = FIVE_MIN_MS;
    const bigWindow = 3 * 24 * 60 * 60_000;   // 3 days
    const now = Date.now();
    const flooredEnd = Math.floor(now / STEP_L) * STEP_L;
    const flooredStart = Math.floor((now - bigWindow) / STEP_L) * STEP_L;
    // Cover the first day and the last day; leave the entire middle day (>18h) uncovered.
    const oneDay = 24 * 60 * 60_000;
    const observed: number[] = [];
    for (let ts = flooredStart; ts <= flooredStart + oneDay; ts += STEP_L) observed.push(ts);
    for (let ts = flooredEnd - oneDay; ts <= flooredEnd; ts += STEP_L) observed.push(ts);

    const provider = new RecordingProvider('A');
    await backfillTickers(dbWithObserved(observed), stubRedis, provider, ['A'], { windowMs: bigWindow });

    // Exactly one interior fetch — the missing middle. Its window sits strictly inside the span.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].startTs).toBeGreaterThan(flooredStart);
    expect(provider.calls[0].endTs).toBeLessThanOrEqual(flooredEnd + STEP_L);
  });

  it('forceRefetch → re-downloads the whole window even when fully covered', async () => {
    const now = Date.now();
    const flooredEnd = Math.floor(now / STEP) * STEP;
    const flooredStart = Math.floor((now - windowMs) / STEP) * STEP;
    const observed: number[] = [];
    for (let ts = flooredStart; ts <= flooredEnd; ts += STEP) observed.push(ts);

    const provider = new RecordingProvider('A');
    const results = await backfillTickers(dbWithObserved(observed), stubRedis, provider, ['A'], { windowMs, forceRefetch: true });

    expect(provider.calls).toHaveLength(1);           // one fetch, the whole window
    expect(results[0].fetched).toBeGreaterThan(0);    // bars re-downloaded despite coverage
  });
});
