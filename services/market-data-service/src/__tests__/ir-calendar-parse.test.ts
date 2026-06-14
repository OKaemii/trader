import { describe, it, expect } from 'vitest';
import { parseNextEarningsDate } from '../modules/earnings/infrastructure/ir-calendar-parse.ts';
import {
    APPLE_IR_FUTURE_ADVISORY,
    APPLE_IR_NO_FUTURE_DATE,
    PAGE_NOT_FOUND,
} from './fixtures/ir-calendar-firecrawl.ts';

describe('parseNextEarningsDate', () => {
    const now = Date.UTC(2026, 5, 14);   // 2026-06-14 (the capture date)

    it('extracts the next earnings date from a real-shaped "to announce … results on <date>" advisory', () => {
        const parsed = parseNextEarningsDate(APPLE_IR_FUTURE_ADVISORY, now);
        expect(parsed).not.toBeNull();
        expect(parsed!.dateMs).toBe(Date.UTC(2026, 9, 29));   // October 29, 2026
        expect(parsed!.confidence).toBe(0.8);                 // "will report …" → high confidence
    });

    it('returns null on a REAL IR page that advertises only past results (degrade-to-empty)', () => {
        // The live Apple IR landing page on the capture date carried no future earnings advisory —
        // only a past "quarter ended March 28, 2026" and unrelated newsroom dates.
        expect(parseNextEarningsDate(APPLE_IR_NO_FUTURE_DATE, now)).toBeNull();
    });

    it('ignores a future date that is not on an earnings/results line', () => {
        // "June 9, 2026" sits on a software-preview line (no earnings context) and must be ignored,
        // even though it is in the future.
        const md = 'Apple unveils new features.\n\nJune 9, 2026\n\nSoftware preview details here.';
        expect(parseNextEarningsDate(md, now)).toBeNull();
    });

    it('treats a future earnings date with no explicit verb as lower confidence', () => {
        const md = 'Q3 2026 earnings: 2026-07-31.';
        const parsed = parseNextEarningsDate(md, now);
        expect(parsed).not.toBeNull();
        expect(parsed!.dateMs).toBe(Date.UTC(2026, 6, 31));
        expect(parsed!.confidence).toBe(0.5);
    });

    it('parses day-first European dates on an earnings line', () => {
        const md = 'The company will report half-year results on 30 September 2026.';
        const parsed = parseNextEarningsDate(md, now);
        expect(parsed!.dateMs).toBe(Date.UTC(2026, 8, 30));
        expect(parsed!.confidence).toBe(0.8);
    });

    it('takes the SOONEST future earnings date when several are present', () => {
        const md = [
            'Q3 2026 results conference call on October 29, 2026.',
            'Q4 2026 results expected on January 28, 2027.',
        ].join('\n');
        expect(parseNextEarningsDate(md, now)!.dateMs).toBe(Date.UTC(2026, 9, 29));
    });

    it('rejects an overflow date (Feb 31) rather than rolling it into March', () => {
        const md = 'Earnings call scheduled for February 31, 2027.';
        expect(parseNextEarningsDate(md, now)).toBeNull();
    });

    it('returns null on a "page not found" body (the parser, not the transport, yields the miss)', () => {
        expect(parseNextEarningsDate(PAGE_NOT_FOUND, now)).toBeNull();
    });

    it('returns null on empty markdown', () => {
        expect(parseNextEarningsDate('', now)).toBeNull();
    });
});
