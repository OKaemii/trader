import { describe, it, expect } from 'vitest';
import {
    IrCalendarEarningsProvider,
    type DividendDateLookup,
    type FirecrawlScrapeResult,
    type IrTarget,
} from '../modules/earnings/infrastructure/IrCalendarEarningsProvider.ts';
import { earningsOverlap } from '../modules/earnings/application/overlap.ts';
import { nextDividendDateMs } from '../modules/earnings/infrastructure/next-dividend.ts';
import {
    APPLE_IR_FUTURE_ADVISORY,
    APPLE_IR_NO_FUTURE_DATE,
} from './fixtures/ir-calendar-firecrawl.ts';

const NOW = Date.UTC(2026, 5, 14);
const DAY = 24 * 60 * 60 * 1000;

const targets: Record<string, IrTarget[]> = {
    AAPL_US_EQ: [{ url: 'https://investor.apple.com/', name: 'investor.apple.com' }],
};

// Build a provider whose scrape returns a canned markdown per url (or null = transport miss).
function providerWith(
    byUrl: Record<string, FirecrawlScrapeResult | null>,
    overrides: { dividendDateLookup?: DividendDateLookup } = {},
) {
    return new IrCalendarEarningsProvider({
        firecrawlBaseUrl: 'http://firecrawl.test',
        targets,
        requestSpacingMs: 0,
        now: () => NOW,
        scrape: async (url) => byUrl[url] ?? null,
        dividendDateLookup: overrides.dividendDateLookup,
    });
}

describe('IrCalendarEarningsProvider', () => {
    it('parses a Firecrawl advisory fixture into a calendar row with source + confidence', async () => {
        const provider = providerWith({
            'https://investor.apple.com/': { markdown: APPLE_IR_FUTURE_ADVISORY, statusCode: 200 },
        });
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out.AAPL_US_EQ).toBeDefined();
        expect(out.AAPL_US_EQ!.nextEarningsDate).toBe(Date.UTC(2026, 9, 29));   // October 29, 2026
        expect(out.AAPL_US_EQ!.source).toBe('ir-calendar:investor.apple.com');
        expect(out.AAPL_US_EQ!.confidence).toBe(0.8);
    });

    it('omits the ticker when the page renders but carries no future earnings date (real IR page)', async () => {
        const provider = providerWith({
            'https://investor.apple.com/': { markdown: APPLE_IR_NO_FUTURE_DATE, statusCode: 200 },
        });
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out).toEqual({});   // degrade-to-empty: no row written

        // And the overlap detector, fed the empty result, flags nothing (no false "reports soon").
        const overlap = earningsOverlap(['AAPL_US_EQ'], out, NOW, 10);
        expect(overlap[0]!.within).toBe(false);
        expect(overlap[0]!.nextEarningsDate).toBeNull();
    });

    it('omits the ticker on a transport miss (Firecrawl unreachable → scrape returns null)', async () => {
        const provider = providerWith({ 'https://investor.apple.com/': null });
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out).toEqual({});
        expect(earningsOverlap(['AAPL_US_EQ'], out, NOW, 10)[0]!.within).toBe(false);
    });

    it('omits a ticker that has no configured IR target', async () => {
        const provider = providerWith({});
        expect(await provider.fetch(['ZZZZ_US_EQ'])).toEqual({});
    });

    it('includes a dividend-only ticker (earnings missing) from the injected dividend lookup', async () => {
        const divMs = NOW + 20 * DAY;
        const provider = providerWith(
            { 'https://investor.apple.com/': { markdown: APPLE_IR_NO_FUTURE_DATE } },
            { dividendDateLookup: (t) => (t === 'AAPL_US_EQ' ? divMs : undefined) },
        );
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out.AAPL_US_EQ!.dividendDate).toBe(divMs);
        expect(out.AAPL_US_EQ!.nextEarningsDate).toBeUndefined();   // earnings still omitted
        expect(out.AAPL_US_EQ!.source).toBeUndefined();             // no earnings ⇒ no earnings source
    });

    it('carries BOTH the scraped earnings date and the injected dividend date', async () => {
        const divMs = NOW + 5 * DAY;
        const provider = providerWith(
            { 'https://investor.apple.com/': { markdown: APPLE_IR_FUTURE_ADVISORY } },
            { dividendDateLookup: () => divMs },
        );
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out.AAPL_US_EQ!.nextEarningsDate).toBe(Date.UTC(2026, 9, 29));
        expect(out.AAPL_US_EQ!.dividendDate).toBe(divMs);
    });

    it('isolates a per-target scrape failure (a dead first URL does not lose a working second)', async () => {
        const multi: Record<string, IrTarget[]> = {
            AAPL_US_EQ: [
                { url: 'https://dead.example/', name: 'dead.example' },
                { url: 'https://good.example/', name: 'good.example' },
            ],
        };
        const provider = new IrCalendarEarningsProvider({
            firecrawlBaseUrl: 'http://firecrawl.test',
            targets: multi,
            requestSpacingMs: 0,
            now: () => NOW,
            scrape: async (url) =>
                url === 'https://good.example/' ? { markdown: APPLE_IR_FUTURE_ADVISORY } : null,
        });
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out.AAPL_US_EQ!.nextEarningsDate).toBe(Date.UTC(2026, 9, 29));
        expect(out.AAPL_US_EQ!.source).toBe('ir-calendar:good.example');
    });

    it('does not throw — and omits the ticker — when the dividend lookup throws', async () => {
        const provider = providerWith(
            { 'https://investor.apple.com/': { markdown: APPLE_IR_NO_FUTURE_DATE } },
            { dividendDateLookup: () => { throw new Error('mongo down'); } },
        );
        const out = await provider.fetch(['AAPL_US_EQ']);
        expect(out).toEqual({});   // earnings missed + dividend errored → omitted, no throw
    });
});

describe('nextDividendDateMs (corporate_actions next-dividend selection)', () => {
    it('returns the soonest future ex-date, skipping past ones', () => {
        const dates = ['2025-02-10', '2026-08-15', '2026-07-01'];
        expect(nextDividendDateMs(dates, NOW)).toBe(Date.UTC(2026, 6, 1));
    });

    it('returns undefined when every stored dividend is in the past (the common case)', () => {
        expect(nextDividendDateMs(['2024-05-10', '2025-11-09'], NOW)).toBeUndefined();
    });

    it('skips unparseable dates', () => {
        expect(nextDividendDateMs(['not-a-date', '2026-09-01'], NOW)).toBe(Date.UTC(2026, 8, 1));
    });

    it('returns undefined on an empty list', () => {
        expect(nextDividendDateMs([], NOW)).toBeUndefined();
    });
});
