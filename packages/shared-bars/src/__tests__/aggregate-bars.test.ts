// Tests for aggregateBars — locks in the OHLCV roll-up rules used by every consumer
// (admin /bars endpoint, strategy-engine downsampler, portal charts).
//
// The bucket-by-floor invariant is the part most likely to be misunderstood: a daily
// bucket starts at UTC 00:00:00 of the calendar day. LSE and US bars on the same
// trading day fold into the same daily bucket even though their bar timestamps differ
// by several hours.

import { describe, it, expect } from "vitest";
import { aggregateBars } from '../index.ts';
import type { OHLCVBar } from '@trader/shared-types';

function bar(ts: number, o: number, h: number, l: number, c: number, v: number): OHLCVBar {
  return { ticker: 'AAPL_US_EQ', timestamp: ts, interval: '5m', open: o, high: h, low: l, close: c, volume: v };
}

describe('aggregateBars', () => {
  it('returns input unchanged when source and target intervals match', () => {
    const src = [bar(0, 1, 2, 0.5, 1.5, 100)];
    expect(aggregateBars(src, '5m')).toEqual(src);
  });

  it('returns empty array for empty input', () => {
    expect(aggregateBars([], 'daily')).toEqual([]);
  });

  it('aggregates 5m → 15m: 3 bars per bucket, open=first, close=last, hi=max, lo=min, vol=sum', () => {
    // Three 5m bars inside a single 15m bucket (00:00 - 00:15)
    const fiveMin = 5 * 60_000;
    const src = [
      bar(0,             10, 12, 9,  11, 100),
      bar(fiveMin,       11, 14, 10, 13, 200),
      bar(fiveMin * 2,   13, 13, 8,  9,  300),
    ];
    const out = aggregateBars(src, '15m');
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(0);
    expect(out[0].interval).toBe('15m');
    expect(out[0].open).toBe(10);
    expect(out[0].high).toBe(14);
    expect(out[0].low).toBe(8);
    expect(out[0].close).toBe(9);
    expect(out[0].volume).toBe(600);
  });

  it('places bars in correct buckets when they span multiple buckets', () => {
    const fifteenMin = 15 * 60_000;
    const src = [
      bar(0,                       100, 100, 100, 100, 10),
      bar(fifteenMin - 60_000,     101, 101, 101, 101, 20),  // still bucket 0
      bar(fifteenMin,              200, 200, 200, 200, 30),  // bucket 1
      bar(fifteenMin + 60_000,     201, 201, 201, 201, 40),
    ];
    const out = aggregateBars(src, '15m');
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBe(0);
    expect(out[0].volume).toBe(30);
    expect(out[1].timestamp).toBe(fifteenMin);
    expect(out[1].volume).toBe(70);
  });

  it('aggregates 5m → daily by UTC date — LSE/US same-day bars fold together', () => {
    // UTC 2026-05-14, two snapshots of the same trading day at different exchanges:
    // LSE midday (~12:00 UTC) and US open (~14:30 UTC). Both fold into the same daily
    // bucket (00:00:00 UTC of that calendar day).
    const dayStart  = Date.UTC(2026, 4, 14, 0, 0, 0);
    const lseNoon   = Date.UTC(2026, 4, 14, 12, 0, 0);
    const usOpen    = Date.UTC(2026, 4, 14, 14, 30, 0);
    const src = [
      bar(lseNoon, 100, 105, 99, 102, 500),
      bar(usOpen,  102, 110, 101, 108, 800),
    ];
    const out = aggregateBars(src, 'daily');
    expect(out).toHaveLength(1);
    expect(out[0].timestamp).toBe(dayStart);
    expect(out[0].interval).toBe('daily');
    // Order within the bucket is by timestamp ascending — so open is LSE, close is US.
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(108);
    expect(out[0].high).toBe(110);
    expect(out[0].low).toBe(99);
    expect(out[0].volume).toBe(1300);
  });

  it('emits buckets sorted oldest-first regardless of input order', () => {
    const dayMs = 24 * 60 * 60_000;
    const src = [
      bar(dayMs * 2, 30, 30, 30, 30, 30),
      bar(0,         10, 10, 10, 10, 10),
      bar(dayMs,     20, 20, 20, 20, 20),
    ];
    const out = aggregateBars(src, 'daily');
    expect(out.map((b) => b.open)).toEqual([10, 20, 30]);
  });
});
