import { describe, it, expect } from 'vitest';
import { earningsOverlap } from '../modules/earnings/application/overlap.ts';
import { extractEarningsInfo } from '../modules/earnings/infrastructure/YahooEarningsProvider.ts';

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

describe('extractEarningsInfo (Yahoo calendarEvents)', () => {
    it('converts raw unix seconds to UTC ms for earnings + dividend', () => {
        const sec = 1781000000;
        const ce = { earnings: { earningsDate: [{ raw: sec, fmt: '2026-06-09' }] }, dividendDate: { raw: sec + 100, fmt: 'x' } };
        const info = extractEarningsInfo(ce);
        expect(info.nextEarningsDate).toBe(sec * 1000);
        expect(info.dividendDate).toBe((sec + 100) * 1000);
    });

    it('returns empty info when calendarEvents is missing or has no dates', () => {
        expect(extractEarningsInfo(undefined)).toEqual({});
        expect(extractEarningsInfo({})).toEqual({});
        expect(extractEarningsInfo({ earnings: {} })).toEqual({});
    });

    it('accepts a bare-number earningsDate', () => {
        expect(extractEarningsInfo({ earnings: { earningsDate: [1781000000] } }).nextEarningsDate)
            .toBe(1781000000 * 1000);
    });
});
