import { describe, it, expect } from 'vitest';
import { screenTicker, DEFAULT_THRESHOLDS } from '../modules/screener/screen.ts';
import type { OHLCVBar } from '@trader/shared-types';

function bar(i: number, close: number, high = close, vol = 100): OHLCVBar {
    const ts = Date.UTC(2026, 0, 1) + i * 86_400_000;
    return { ticker: 'T', observation_ts: ts, timestamp: ts, interval: 'daily', open: close, high, low: close, close, volume: vol };
}

describe('screenTicker', () => {
    it('returns null with fewer than 50 bars', () => {
        expect(screenTicker('T', Array.from({ length: 40 }, (_, i) => bar(i, 100)), DEFAULT_THRESHOLDS)).toBeNull();
    });

    it('flags near-52w-high + unusual-volume on a rising series with a volume spike', () => {
        const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));   // rising 100..159
        bars[59] = bar(59, 159, 159, 500);                                    // last bar volume spike
        const row = screenTicker('T', bars, DEFAULT_THRESHOLDS)!;
        expect(row.signals).toContain('near_52w_high');
        expect(row.signals).toContain('unusual_volume');
        expect(row.volSurge).toBeCloseTo(5, 1);                               // 500 / trailing-20 (100)
        expect(row.score).toBeGreaterThan(0);
    });

    it('flags a fresh 50-MA breakout in isolation (not near the 52w high)', () => {
        const bars = Array.from({ length: 55 }, (_, i) => bar(i, 100));
        bars[0] = bar(0, 100, 200);    // early intraday spike → 52w high = 200
        bars[54] = bar(54, 105);       // last close pops above the ~100.1 SMA50
        const row = screenTicker('T', bars, DEFAULT_THRESHOLDS)!;
        expect(row.signals).toContain('breakout_50ma');
        expect(row.signals).not.toContain('near_52w_high');
    });

    it('respects a threshold override — raising volSurgeMult suppresses the volume signal', () => {
        const bars = Array.from({ length: 60 }, (_, i) => bar(i, 100 + i));
        bars[59] = bar(59, 159, 159, 500);
        const row = screenTicker('T', bars, { ...DEFAULT_THRESHOLDS, volSurgeMult: 10 })!;
        expect(row.signals).not.toContain('unusual_volume');                  // 5x < 10x
    });
});
