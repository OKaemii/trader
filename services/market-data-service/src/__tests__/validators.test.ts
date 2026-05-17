import { describe, it, expect } from "vitest";
import { BarValidator } from '../bar-validator.ts';
import { GapDetector } from '../gap-detector.ts';
import { StaleDetector } from '../stale-detector.ts';
import type { OHLCVBar } from '@trader/shared-types';

function makeBar(overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  return {
    ticker: 'AAPL',
    timestamp: Date.now(),
    open: 100,
    high: 105,
    low: 95,
    close: 102,
    volume: 1_000_000,
    ...overrides,
  };
}

describe('BarValidator', () => {
  it('passes a valid bar', () => {
    const v = new BarValidator();
    const { valid, invalid } = v.validate([makeBar()]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it('rejects bar with non-positive close', () => {
    const v = new BarValidator();
    const { valid, invalid } = v.validate([makeBar({ close: 0 })]);
    expect(valid).toHaveLength(0);
    expect(invalid[0].reason).toContain('non-positive close');
  });

  it('rejects bar with non-positive open', () => {
    const v = new BarValidator();
    const { invalid } = v.validate([makeBar({ open: -1 })]);
    expect(invalid[0].reason).toContain('non-positive OHLC');
  });

  it('rejects bar with inverted OHLC (high < low)', () => {
    const v = new BarValidator();
    const { invalid } = v.validate([makeBar({ high: 90, low: 95, close: 92, open: 91 })]);
    expect(invalid[0].reason).toContain('inverted OHLC');
  });

  it('rejects bar with negative volume', () => {
    const v = new BarValidator();
    const { invalid } = v.validate([makeBar({ volume: -1 })]);
    expect(invalid[0].reason).toContain('negative volume');
  });

  it('rejects bar with close above high', () => {
    const v = new BarValidator();
    const { invalid } = v.validate([makeBar({ close: 110, high: 105 })]);
    expect(invalid[0].reason).toContain('close outside');
  });

  it('rejects bar with close below low', () => {
    const v = new BarValidator();
    const { invalid } = v.validate([makeBar({ close: 90, low: 95, open: 96 })]);
    expect(invalid[0].reason).toContain('close outside');
  });

  it('rejects z-score spike after sufficient history', () => {
    const v = new BarValidator();
    // Build 10-bar history near 100
    const history = Array.from({ length: 10 }, (_, i) =>
      makeBar({ ticker: 'TEST', open: 100, high: 106, low: 94, close: 100 + i * 0.1 }),
    );
    const { valid: h } = v.validate(history);
    expect(h.length).toBeGreaterThan(0);
    // Spike to 2000 — far beyond 10σ
    const spike = makeBar({ ticker: 'TEST', open: 2000, high: 2100, low: 1900, close: 2000 });
    const { invalid } = v.validate([spike]);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].reason).toContain('z-score');
  });

  it('accepts multiple valid bars at once', () => {
    const v = new BarValidator();
    const bars = [
      makeBar({ ticker: 'AAPL' }),
      makeBar({ ticker: 'MSFT' }),
      makeBar({ ticker: 'GOOG' }),
    ];
    const { valid, invalid } = v.validate(bars);
    expect(valid).toHaveLength(3);
    expect(invalid).toHaveLength(0);
  });
});

describe('GapDetector', () => {
  const gd = new GapDetector(60_000);

  it('returns gapFraction 0 when all expected tickers received', () => {
    const bars = [makeBar({ ticker: 'AAPL' }), makeBar({ ticker: 'MSFT' })];
    const { gapFraction, missingTickers } = gd.check(['AAPL', 'MSFT'], bars);
    expect(gapFraction).toBe(0);
    expect(missingTickers).toHaveLength(0);
  });

  it('reports correct missing tickers and gapFraction', () => {
    const bars = [makeBar({ ticker: 'AAPL' })];
    const { gapFraction, missingTickers } = gd.check(['AAPL', 'MSFT', 'GOOG'], bars);
    expect(missingTickers).toContain('MSFT');
    expect(missingTickers).toContain('GOOG');
    expect(gapFraction).toBeCloseTo(2 / 3);
  });

  it('returns gapFraction 1 when all expected tickers are missing', () => {
    const { gapFraction, missingTickers } = gd.check(['AAPL', 'MSFT'], []);
    expect(gapFraction).toBe(1);
    expect(missingTickers).toHaveLength(2);
  });

  it('returns 0 for empty expected universe regardless of received bars', () => {
    const { gapFraction } = gd.check([], [makeBar()]);
    expect(gapFraction).toBe(0);
  });
});

describe('StaleDetector', () => {
  it('marks fresh bars as fresh', () => {
    const sd = new StaleDetector(60_000);
    const bar = makeBar({ timestamp: Date.now() - 1_000 });
    const { fresh, stale } = sd.check([bar]);
    expect(fresh).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });

  it('marks stale bars as stale', () => {
    const sd = new StaleDetector(60_000);
    const bar = makeBar({ timestamp: Date.now() - 120_000 });
    const { fresh, stale } = sd.check([bar]);
    expect(fresh).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it('partitions mixed bars correctly', () => {
    const sd = new StaleDetector(60_000);
    const bars = [
      makeBar({ ticker: 'A', timestamp: Date.now() - 1_000 }),
      makeBar({ ticker: 'B', timestamp: Date.now() - 120_000 }),
    ];
    const { fresh, stale } = sd.check(bars);
    expect(fresh.map((b) => b.ticker)).toContain('A');
    expect(stale.map((b) => b.ticker)).toContain('B');
  });

  it('returns empty arrays for empty input', () => {
    const sd = new StaleDetector(60_000);
    const { fresh, stale } = sd.check([]);
    expect(fresh).toHaveLength(0);
    expect(stale).toHaveLength(0);
  });
});
