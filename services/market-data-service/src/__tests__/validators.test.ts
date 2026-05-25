import { describe, it, expect } from "vitest";
import { BarValidator } from '../modules/bars/infrastructure/bar-validator.ts';
import { GapDetector } from '../modules/bars/infrastructure/gap-detector.ts';
import { StaleDetector } from '../modules/bars/infrastructure/stale-detector.ts';
import type { OHLCVBar } from '@trader/shared-types';

function makeBar(overrides: Partial<OHLCVBar> = {}): OHLCVBar {
  const now = Date.now();
  return {
    ticker: 'AAPL',
    observation_ts: now,
    timestamp:      now,
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

  // ── First-print isolation (bi-temporal storage) ────────────────────────────
  // The validator's rolling z-score window is built from FIRST-PRINT closes only;
  // revisions (key present in ctx.firstPrintCloseByKey) are sanity-checked but do
  // NOT update the window. This prevents a corrected close from re-weighting
  // subsequent z-score gating for legitimately new bars.
  describe('first-print isolation', () => {
    it('marks bars as revisions when their key is in firstPrintCloseByKey — close still passes if valid', () => {
      const v = new BarValidator();
      const obs = 1_700_000_000_000;
      const bar = makeBar({ ticker: 'AAPL', observation_ts: obs, close: 100 });
      const { valid, invalid, revisionAnomalies } = v.validate([bar], {
        firstPrintCloseByKey: new Map([[`AAPL|${obs}`, 100]]),
      });
      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(0);
      // Drift = 0 → not anomalous.
      expect(revisionAnomalies).toHaveLength(0);
    });

    it('does NOT inject revision closes into the rolling z-score window', () => {
      // Setup: feed 5 first-prints all at close=100 to seed the window. Then a revision
      // of one of those bars at close=200. Without isolation, a 6th first-print at
      // close=200 would NOT trigger z-score rejection (window has been mutated). With
      // isolation, the window still sees only first-prints around 100, and any future
      // bar near 200 trips the z-score gate.
      const v = new BarValidator();
      const baseObs = 1_700_000_000_000;
      // 10 first-prints around close=100 — wide enough variance to build a stddev.
      const firstPrints = Array.from({ length: 10 }, (_, i) =>
        makeBar({ ticker: 'TEST', observation_ts: baseObs + i, open: 100, high: 106, low: 94, close: 100 + i * 0.1 }),
      );
      v.validate(firstPrints);
      // Revision of bar #5 jumping to close=200. With isolation, this should NOT widen
      // the rolling window — the validator's history stays in the ~100 neighbourhood.
      const revisionObs = baseObs + 5;
      const revision = makeBar({ ticker: 'TEST', observation_ts: revisionObs, open: 200, high: 210, low: 190, close: 200 });
      v.validate([revision], {
        firstPrintCloseByKey: new Map([[`TEST|${revisionObs}`, 100.5]]),
      });
      // Now a NEW first-print at close=200 — if the window were poisoned by the revision,
      // this would pass (200 wouldn't be > 10σ from the recently-revised series). With
      // isolation, the window mean is still ~100 and 200 trips the gate.
      const futureFirstPrint = makeBar({ ticker: 'TEST', observation_ts: baseObs + 100, open: 200, high: 210, low: 190, close: 200 });
      const { invalid } = v.validate([futureFirstPrint]);
      expect(invalid).toHaveLength(1);
      expect(invalid[0].reason).toContain('z-score');
    });

    it('emits revisionAnomalies when a revision close drifts >5% from first-print', () => {
      const v = new BarValidator();
      const obs = 1_700_000_000_000;
      // First-print close=100. Revision close=110 — 10% drift, above the 5% threshold.
      const revision = makeBar({ ticker: 'AAPL', observation_ts: obs, open: 110, high: 111, low: 109, close: 110 });
      const { valid, revisionAnomalies } = v.validate([revision], {
        firstPrintCloseByKey: new Map([[`AAPL|${obs}`, 100]]),
      });
      // Revision still goes into `valid` — it's real data we want to store, just flagged.
      expect(valid).toHaveLength(1);
      expect(revisionAnomalies).toHaveLength(1);
      expect(revisionAnomalies[0].firstPrintClose).toBe(100);
      expect(revisionAnomalies[0].driftFraction).toBeCloseTo(0.1, 4);
      expect(revisionAnomalies[0].bar).toBe(revision);
    });

    it('does NOT emit revisionAnomalies for small revisions (<5% drift)', () => {
      const v = new BarValidator();
      const obs = 1_700_000_000_000;
      // 1% drift — within the threshold.
      const revision = makeBar({ ticker: 'AAPL', observation_ts: obs, close: 101 });
      const { revisionAnomalies } = v.validate([revision], {
        firstPrintCloseByKey: new Map([[`AAPL|${obs}`, 100]]),
      });
      expect(revisionAnomalies).toHaveLength(0);
    });

    it('preserves legacy behaviour when ctx is omitted — every bar is a first-print', () => {
      const v = new BarValidator();
      // Widen high/low so the linearly-rising closes stay inside the OHLC range.
      const bars = Array.from({ length: 10 }, (_, i) =>
        makeBar({ ticker: 'X', observation_ts: 1_000 + i, close: 100 + i, open: 100 + i, high: 120, low: 90 }),
      );
      const result = v.validate(bars);   // No ctx — equivalent to legacy validate(bars).
      expect(result.valid).toHaveLength(10);
      expect(result.revisionAnomalies).toEqual([]);
    });
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
    const bar = makeBar({ observation_ts: Date.now() - 1_000 });
    const { fresh, stale } = sd.check([bar]);
    expect(fresh).toHaveLength(1);
    expect(stale).toHaveLength(0);
  });

  it('marks stale bars as stale', () => {
    const sd = new StaleDetector(60_000);
    const bar = makeBar({ observation_ts: Date.now() - 120_000 });
    const { fresh, stale } = sd.check([bar]);
    expect(fresh).toHaveLength(0);
    expect(stale).toHaveLength(1);
  });

  it('partitions mixed bars correctly', () => {
    const sd = new StaleDetector(60_000);
    const bars = [
      makeBar({ ticker: 'A', observation_ts: Date.now() - 1_000 }),
      makeBar({ ticker: 'B', observation_ts: Date.now() - 120_000 }),
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
