import { describe, it, expect } from 'vitest';
import { earningsOverlap } from '../modules/earnings/application/overlap.ts';
import { StubEarningsProvider } from '../modules/earnings/infrastructure/StubEarningsProvider.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('earningsOverlap', () => {
    const now = Date.UTC(2026, 5, 1);

    it('flags a report within the window — inclusive boundary at exactly 10 days', () => {
        const by = {
            A: { nextEarningsDate: now + 10 * DAY },
            B: { nextEarningsDate: now + 10 * DAY + 1 },
            C: { nextEarningsDate: now + 4 * DAY },
        };
        const out = earningsOverlap(['A', 'B', 'C'], by, now, 10);
        expect(out.find((o) => o.ticker === 'A')!.within).toBe(true);    // exactly 10 days → in
        expect(out.find((o) => o.ticker === 'B')!.within).toBe(false);   // 10 days + 1ms → out
        expect(out.find((o) => o.ticker === 'C')!.within).toBe(true);    // 4 days
        expect(out.find((o) => o.ticker === 'C')!.daysUntil).toBeCloseTo(4);
    });

    it('passes through unknown coverage as within:false (no false flag, no false all-clear)', () => {
        expect(earningsOverlap(['X'], {}, now, 10)[0])
            .toEqual({ ticker: 'X', nextEarningsDate: null, daysUntil: null, within: false });
    });

    it('does not flag an earnings date already in the past', () => {
        const out = earningsOverlap(['P'], { P: { nextEarningsDate: now - DAY } }, now, 10);
        expect(out[0]!.within).toBe(false);
        expect(out[0]!.daysUntil).toBeCloseTo(-1);
    });
});

// The earnings source is stubbed (decision I — Yahoo dropped, no PIT source wired yet). The stub
// returns no dates, so the overlap-detector degrades to a clean no-op: every ticker comes back
// within:false (never a false flag, never a false "no earnings soon").
describe('StubEarningsProvider (no-op placeholder)', () => {
    const now = Date.UTC(2026, 5, 1);

    it('returns an empty map for any tickers (no dates available)', async () => {
        const provider = new StubEarningsProvider();
        expect(await provider.fetch(['AAPL_US_EQ', 'MSFT_US_EQ', 'SHELl_EQ'])).toEqual({});
        expect(await provider.fetch([])).toEqual({});
    });

    it('feeding the stub output into the overlap-detector flags nothing', async () => {
        const provider = new StubEarningsProvider();
        const tickers = ['AAPL_US_EQ', 'MSFT_US_EQ'];
        const byTicker = await provider.fetch(tickers);
        const out = earningsOverlap(tickers, byTicker, now, 10);
        expect(out.every((o) => o.within === false)).toBe(true);
        expect(out.every((o) => o.nextEarningsDate === null && o.daysUntil === null)).toBe(true);
    });
});
