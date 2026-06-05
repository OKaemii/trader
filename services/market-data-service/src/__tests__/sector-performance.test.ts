import { describe, it, expect } from 'vitest';
import { computeSectorPerf } from '../modules/sectors/SectorPerformance.ts';
import { sectorLabel, sectorEtfTickers } from '../modules/sectors/sector-etfs.ts';
import type { OHLCVBar } from '@trader/shared-types';

function dailyBar(ts: number, close: number): OHLCVBar {
    return { ticker: 'XLK_US_EQ', observation_ts: ts, timestamp: ts, interval: 'daily', open: close, high: close, low: close, close, volume: 100 };
}
const WEEK = 7 * 24 * 60 * 60 * 1000;

describe('computeSectorPerf', () => {
    it('derives weekly + trailing returns from a daily series', () => {
        const d0 = Date.UTC(2026, 0, 7);
        // One bar per ISO week (7 days apart), closes +10% each week: 100 → 110 → 121.
        const bars = [dailyBar(d0, 100), dailyBar(d0 + WEEK, 110), dailyBar(d0 + 2 * WEEK, 121)];
        const perf = computeSectorPerf('XLK_US_EQ', 'Technology', bars, 13);
        expect(perf.sector).toBe('Technology');
        expect(perf.weekReturns).toHaveLength(2);     // 3 weekly closes → 2 returns
        expect(perf.weekReturns[0]).toBeCloseTo(0.10);
        expect(perf.weekReturns[1]).toBeCloseTo(0.10);
        expect(perf.latest).toBeCloseTo(0.10);
        expect(perf.trailing4w).toBeNull();           // not enough weeks
    });

    it('handles a series too short for any return', () => {
        const perf = computeSectorPerf('SPY_US_EQ', 'S&P 500', [dailyBar(Date.UTC(2026, 0, 7), 100)], 13);
        expect(perf.weekReturns).toHaveLength(0);
        expect(perf.latest).toBeNull();
        expect(perf.trailing13w).toBeNull();
    });
});

describe('sector-etf config', () => {
    it('labels ETF tickers and defaults to the 12-name reference set', () => {
        expect(sectorLabel('XLK_US_EQ')).toBe('Technology');
        expect(sectorLabel('SPY_US_EQ')).toBe('S&P 500');
        expect(sectorEtfTickers()).toContain('XLE_US_EQ');
        expect(sectorEtfTickers().length).toBe(12);
    });
});
