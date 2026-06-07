// Tests the gap-aware FETCH planning for the long-range DAILY backfill (Task 16, §I). The
// daily series is the price-factor source, so re-running its multi-year backfill on covered
// data must spend ZERO EODHD credits. The write path (writeBarRevisions, bi-temporal +
// hash-gated) is unchanged and mocked here — the concern is purely which dates get fetched.

process.env.INTERNAL_SECRET = 'test-internal-secret';
// Default provider is Yahoo; pin it so the dispatch is deterministic regardless of env.
delete process.env.DAILY_HISTORY_PROVIDER;

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OHLCVBar } from '@trader/shared-types';

const DAY_MS = 24 * 60 * 60 * 1000;

vi.mock('../modules/bars/infrastructure/persist-bars.ts', () => ({
  writeBarRevisions: vi.fn(async (_db: unknown, bars: OHLCVBar[]) => ({
    attempted: bars.length,
    inserted:  bars.length,
    revisions: 0,
    skipped:   0,
  })),
  ensureBiTemporalIndexes: vi.fn(async () => {}),
}));

// Record each (startMs, endMs) the Yahoo daily provider is asked for, and synthesise one
// daily bar per UTC-midnight grid point inside [startMs, endMs). EODHD provider is stubbed to
// throw so a wrong dispatch is loud.
const yahooCalls: Array<{ startMs: number; endMs: number }> = [];
vi.mock('../modules/bars/infrastructure/providers/yahoo-client.ts', () => ({
  fetchYahooDailyHistory: vi.fn(async (ticker: string, startMs: number, endMs: number) => {
    yahooCalls.push({ startMs, endMs });
    const bars: OHLCVBar[] = [];
    const first = Math.ceil(startMs / DAY_MS) * DAY_MS;
    for (let ts = first; ts < endMs; ts += DAY_MS) {
      bars.push({ ticker, observation_ts: ts, timestamp: ts, interval: 'daily', open: 1, high: 1, low: 1, close: 1, volume: 1 });
    }
    return bars;
  }),
}));
vi.mock('../modules/bars/infrastructure/providers/eodhd-client.ts', () => ({
  fetchEodhdDailyHistory: vi.fn(async () => { throw new Error('eodhd path should not be hit in this test'); }),
}));

import { backfillDailyHistory } from '../modules/bars/infrastructure/daily-history.ts';

function dbWithObserved(observed: number[]) {
  return {
    collection: () => ({
      find: () => ({ toArray: async () => observed.map((ts) => ({ observation_ts: ts })) }),
    }),
  } as any;
}

const stubRedis = { del: async () => 0, publish: async () => 0 } as any;

// Build a covered daily set: every weekday UTC-midnight from flooredStart..flooredEnd. The
// planner floors to the day grid and bridges weekend/holiday holes (≤4d) so a weekday-complete
// series reads as full coverage.
function weekdaySeries(flooredStart: number, flooredEnd: number): number[] {
  const out: number[] = [];
  for (let ts = flooredStart; ts <= flooredEnd; ts += DAY_MS) {
    const dow = new Date(ts).getUTCDay();   // 0 Sun, 6 Sat
    if (dow !== 0 && dow !== 6) out.push(ts);
  }
  return out;
}

describe('backfillDailyHistory — gap-aware fetch (§I)', () => {
  beforeEach(() => { yahooCalls.length = 0; });

  it('FULL weekday coverage → ZERO upstream calls (weekends bridged, not re-fetched)', async () => {
    const years = 1;
    const now = Date.now();
    const flooredEnd = Math.floor(now / DAY_MS) * DAY_MS;
    const flooredStart = Math.floor((now - years * 365 * DAY_MS) / DAY_MS) * DAY_MS;
    const observed = weekdaySeries(flooredStart, flooredEnd);

    const results = await backfillDailyHistory(dbWithObserved(observed), stubRedis, ['AAPL_US_EQ'], { years });

    expect(yahooCalls).toHaveLength(0);   // ← load-bearing: covered weekday series ⇒ no fetch
    expect(results[0].fetched).toBe(0);
    expect(results[0].upserted).toBe(0);
  });

  it('empty store → fetches the whole span', async () => {
    const results = await backfillDailyHistory(dbWithObserved([]), stubRedis, ['AAPL_US_EQ'], { years: 1 });
    expect(yahooCalls.length).toBeGreaterThanOrEqual(1);
    expect(results[0].fetched).toBeGreaterThan(0);
  });

  it('TAIL gap → fetches only the missing recent dates', async () => {
    const years = 1;
    const now = Date.now();
    const flooredEnd = Math.floor(now / DAY_MS) * DAY_MS;
    const flooredStart = Math.floor((now - years * 365 * DAY_MS) / DAY_MS) * DAY_MS;
    // Cover everything up to 30 days ago; the last ~month is missing.
    const cutoff = flooredEnd - 30 * DAY_MS;
    const observed = weekdaySeries(flooredStart, cutoff);

    const results = await backfillDailyHistory(dbWithObserved(observed), stubRedis, ['AAPL_US_EQ'], { years });

    expect(yahooCalls).toHaveLength(1);
    // The fetch must start in the recent tail, not back at flooredStart — i.e. near `cutoff`,
    // not at the start of the year-long window. (Allow a few days slack for a weekend boundary.)
    expect(yahooCalls[0].startMs).toBeGreaterThanOrEqual(cutoff - 4 * DAY_MS);
    expect(yahooCalls[0].startMs).toBeGreaterThan(flooredStart + 300 * DAY_MS);
    expect(results[0].fetched).toBeGreaterThan(0);
  });

  it('forceRefetch → re-downloads the whole span even when fully covered', async () => {
    const years = 1;
    const now = Date.now();
    const flooredEnd = Math.floor(now / DAY_MS) * DAY_MS;
    const flooredStart = Math.floor((now - years * 365 * DAY_MS) / DAY_MS) * DAY_MS;
    const observed = weekdaySeries(flooredStart, flooredEnd);

    const results = await backfillDailyHistory(dbWithObserved(observed), stubRedis, ['AAPL_US_EQ'], { years, forceRefetch: true });

    expect(yahooCalls).toHaveLength(1);            // whole-span single fetch
    expect(results[0].fetched).toBeGreaterThan(0); // bars re-downloaded despite coverage
  });
});
