// EODHD bulk daily feed — the pure mapping core (buildEodhdFeedBars). The orchestration
// (runEodhdDailyFeed: Redis NX gate + writeBarRevisions) needs Mongo and is covered by the
// integration path; here we lock in the active-universe filtering + currency scaling.

import { describe, it, expect } from 'vitest';
import { buildEodhdFeedBars } from '../modules/bars/infrastructure/eodhd-daily-feed.ts';
import type { EodhdBulkRow } from '../modules/bars/infrastructure/providers/eodhd-client.ts';

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
