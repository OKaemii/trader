import { describe, it, expect } from 'vitest';
import { scaleT212Quote, type PriceLookupForScaler } from '../shared/T212PriceScaler.ts';

const lookup = (closes: Record<string, number | null>): PriceLookupForScaler => ({
    lastClose: async (t) => (t in closes ? closes[t]! : null),
});

describe('scaleT212Quote', () => {
    it('divides by 100 when T212 reports pence (ratio≈100)', async () => {
        const got = await scaleT212Quote('SGLNl_EQ', 6606, lookup({ SGLNl_EQ: 66.06 }));
        expect(got).toBeCloseTo(66.06);
    });

    it('passes through when T212 already in pounds (ratio≈1, LSE GBP-quoted ETF)', async () => {
        const got = await scaleT212Quote('VFEMl_EQ', 60.60, lookup({ VFEMl_EQ: 60.60 }));
        expect(got).toBe(60.60);
    });

    it('passes through USD tickers (ratio≈1)', async () => {
        const got = await scaleT212Quote('AAPL_US_EQ', 175.32, lookup({ AAPL_US_EQ: 175.10 }));
        expect(got).toBe(175.32);
    });

    it('no-ops when no bar is available', async () => {
        const got = await scaleT212Quote('NEWl_EQ', 9999, lookup({}));
        expect(got).toBe(9999);
    });

    it('no-ops on non-positive price', async () => {
        const got = await scaleT212Quote('SGLNl_EQ', 0, lookup({ SGLNl_EQ: 66.06 }));
        expect(got).toBe(0);
    });

    it('no-ops on edge ratio just below 50', async () => {
        // 49x is suspicious but not within the pence band — leave alone, do not silently scale
        const got = await scaleT212Quote('Xl_EQ', 49, lookup({ Xl_EQ: 1 }));
        expect(got).toBe(49);
    });
});
