import { describe, it, expect } from "vitest";
import { sma, rsi, avgVolume, high52w, low52w, pctReturn } from '../index.ts';

describe('sma', () => {
  it('returns warm-up nulls then the trailing mean', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('period 1 is the series itself', () => {
    expect(sma([4, 8, 2], 1)).toEqual([4, 8, 2]);
  });
  it('throws on a non-positive period', () => {
    expect(() => sma([1, 2], 0)).toThrow();
  });
});

describe('rsi', () => {
  it('returns all-null when there is not enough history', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });
  it('is 100 for a strictly rising series (no losses)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const out = rsi(closes, 14);
    expect(out[13]).toBeNull();        // warm-up
    expect(out[14]).toBe(100);
    expect(out[19]).toBe(100);
  });
  it('is 0 for a strictly falling series (no gains)', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const out = rsi(closes, 14);
    expect(out[14]).toBe(0);
  });
  it('is the neutral 50 for a perfectly flat series', () => {
    const closes = new Array(20).fill(42);
    expect(rsi(closes, 14)[14]).toBe(50);
  });
  it('lands between 0 and 100 for a mixed series', () => {
    const closes = [44, 44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84,
                    46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    const v = rsi(closes, 14)[15];
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(50);
    expect(v!).toBeLessThan(100);
  });
});

describe('avgVolume', () => {
  it('averages the trailing window', () => {
    expect(avgVolume([10, 20, 30], 3)).toBe(20);
    expect(avgVolume([5, 5, 10, 20, 30], 3)).toBe(20); // last 3
  });
  it('returns null without enough history', () => {
    expect(avgVolume([10, 20], 5)).toBeNull();
  });
});

describe('high52w / low52w', () => {
  it('finds the extremes over the whole series when shorter than lookback', () => {
    expect(high52w([3, 1, 4, 1, 5, 9, 2])).toBe(9);
    expect(low52w([3, 1, 4, 1, 5, 9, 2])).toBe(1);
  });
  it('respects the trailing lookback window', () => {
    // A spike early in the series is excluded once it falls outside `lookback`.
    const series = [999, 1, 2, 3, 4, 5];
    expect(high52w(series, 3)).toBe(5);   // last 3 = [3,4,5]
    expect(low52w(series, 3)).toBe(3);
  });
  it('returns null for an empty series', () => {
    expect(high52w([])).toBeNull();
    expect(low52w([])).toBeNull();
  });
});

describe('pctReturn', () => {
  it('computes the simple return', () => {
    expect(pctReturn(100, 110)).toBeCloseTo(0.1, 10);
    expect(pctReturn(100, 90)).toBeCloseTo(-0.1, 10);
  });
  it('guards divide-by-zero', () => {
    expect(pctReturn(0, 50)).toBe(0);
  });
});
