// Task 17: the pence-kill is keyed on `market === 'LSE'` (only LSE listings are ever
// pence-quoted) — a US (USD) quote is never scaled, even at a freak ratio. The lookup takes a
// TickerIdentity; no broker-suffix regex anywhere.

import { describe, it, expect } from 'vitest';
import { scaleT212Quote, type PriceLookupForScaler } from '../shared/T212PriceScaler.ts';
import type { TickerIdentity } from '@trader/ticker-identity';

// Keyed by `${symbol}:${market}` so a US and LSE name with the same symbol resolve distinctly.
const lookup = (closes: Record<string, number | null>): PriceLookupForScaler => ({
    lastClose: async (id: TickerIdentity) => {
        const key = `${id.symbol}:${id.market}`;
        return key in closes ? closes[key]! : null;
    },
});

describe('scaleT212Quote', () => {
    it('divides by 100 when an LSE name reports pence (ratio≈100)', async () => {
        const got = await scaleT212Quote({ symbol: 'SGLN', market: 'LSE' }, 6606, lookup({ 'SGLN:LSE': 66.06 }));
        expect(got).toBeCloseTo(66.06);
    });

    it('passes through when an LSE name is already in pounds (ratio≈1, GBP-quoted ETF)', async () => {
        const got = await scaleT212Quote({ symbol: 'VFEM', market: 'LSE' }, 60.60, lookup({ 'VFEM:LSE': 60.60 }));
        expect(got).toBe(60.60);
    });

    it('passes US (USD) names through unconditionally — never scaled', async () => {
        const got = await scaleT212Quote({ symbol: 'AAPL', market: 'US' }, 175.32, lookup({ 'AAPL:US': 175.10 }));
        expect(got).toBe(175.32);
    });

    it('does NOT scale a US name even at a pence-like ratio (market gate, not the bar ratio)', async () => {
        // A US bar that is somehow 100x off must NOT trigger the pence-kill — a US listing is
        // USD, full stop. The market gate short-circuits before the bar is even read.
        const got = await scaleT212Quote({ symbol: 'XYZ', market: 'US' }, 9900, lookup({ 'XYZ:US': 99 }));
        expect(got).toBe(9900);
    });

    it('no-ops when no bar is available for an LSE name', async () => {
        const got = await scaleT212Quote({ symbol: 'NEW', market: 'LSE' }, 9999, lookup({}));
        expect(got).toBe(9999);
    });

    it('no-ops on non-positive price', async () => {
        const got = await scaleT212Quote({ symbol: 'SGLN', market: 'LSE' }, 0, lookup({ 'SGLN:LSE': 66.06 }));
        expect(got).toBe(0);
    });

    it('no-ops on edge ratio just below 50', async () => {
        // 49x is suspicious but not within the pence band — leave alone, do not silently scale.
        const got = await scaleT212Quote({ symbol: 'X', market: 'LSE' }, 49, lookup({ 'X:LSE': 1 }));
        expect(got).toBe(49);
    });
});
