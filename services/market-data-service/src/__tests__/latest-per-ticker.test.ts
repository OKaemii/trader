// Pinning the publish-to-stream contract:
//   - One bar per ticker hits market:raw each cycle
//   - That one bar is the LATEST aggregated bucket at the target interval
//   - The earlier bug was sending ALL aggregated buckets (which bloated strategy-engine's
//     warmup counter) or NONE (when the stale filter dropped them).
//
// Strategy-engine's rolling-window math treats every arrival as a discrete bar — these
// invariants are load-bearing for downstream warmup + signal generation.

import { describe, it, expect } from "vitest";
import { latestPerTicker } from '../index.ts';
import type { OHLCVBar } from '@trader/shared-types';

function bar(ticker: string, ts: number, close: number): OHLCVBar {
  return {
    ticker, timestamp: ts, interval: '5m',
    open: close, high: close, low: close, close, volume: 1,
  };
}

describe('latestPerTicker', () => {
  it('emits exactly one bar per ticker', () => {
    const fiveMin = 5 * 60_000;
    const bars = [
      bar('A', 0, 1),
      bar('A', fiveMin, 2),
      bar('B', 0, 10),
      bar('B', fiveMin, 11),
    ];
    const out = latestPerTicker(bars, 'daily');
    expect(out).toHaveLength(2);
    const tickers = new Set(out.map((b) => b.ticker));
    expect(tickers).toEqual(new Set(['A', 'B']));
  });

  it('emits the LATEST bucket per ticker (close = last bar in latest bucket)', () => {
    // Day 0: A trades at 100 then 101. Day 1: A trades at 200 then 201.
    // Latest daily bucket for A should reflect day 1, with close=201.
    const day = 24 * 60 * 60_000;
    const bars = [
      bar('A', 0,                100),
      bar('A', 5 * 60_000,        101),
      bar('A', day,               200),
      bar('A', day + 5 * 60_000,  201),
    ];
    const out = latestPerTicker(bars, 'daily');
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(201);
    expect(out[0].timestamp).toBe(day);   // day-1 bucket start
  });

  it('returns empty for empty input', () => {
    expect(latestPerTicker([], 'daily')).toEqual([]);
  });

  it('passes single-bar input through to a one-element daily bucket', () => {
    // A single 5m bar at midday should aggregate up to one daily bar covering that
    // UTC day. This is the case fetchRecent returns on a freshly-deployed bootstrap
    // before the first multi-bar window lands.
    const out = latestPerTicker([bar('A', 12 * 60 * 60_000, 50)], 'daily');
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(50);
  });

  it('treats each ticker independently — A having only old bars does not affect B', () => {
    // Regression for the deploy-time bug where the stale filter killed every bar in
    // the batch when ANY were stale. The per-ticker grouping must scope independently.
    const day = 24 * 60 * 60_000;
    const bars = [
      bar('OLD', 0,    1),        // very old
      bar('NEW', day,  100),      // recent
    ];
    const out = latestPerTicker(bars, 'daily');
    expect(out).toHaveLength(2);
    expect(out.find((b) => b.ticker === 'OLD')?.close).toBe(1);
    expect(out.find((b) => b.ticker === 'NEW')?.close).toBe(100);
  });
});
