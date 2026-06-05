// Yahoo quoteSummary `calendarEvents` — the free default earnings/dividend source. Reuses the
// shared YahooQuoteSummary session (cookie+crumb) the fundamentals provider uses. US coverage is
// solid; LSE earnings dates are patchier and simply come back as unknown (omitted), which the
// store/overlap treat honestly rather than as "no earnings soon".

import { setTimeout as sleep } from 'node:timers/promises';
import type { EarningsProvider, EarningsInfo } from './EarningsProvider.ts';
import { YahooQuoteSummary, type QuoteSummaryFetcher } from '../../bars/infrastructure/providers/yahoo-quote-summary.ts';
import { toYahooSymbol, isBlacklisted } from '../../bars/infrastructure/providers/yahoo-client.ts';
import { log } from '../../../logger.ts';

const MODULES = ['calendarEvents'];

// Yahoo dates are { raw: <unix SECONDS>, fmt } (or a bare number). Returns seconds, or undefined.
function rawSeconds(node: unknown): number | undefined {
    if (typeof node === 'number') return Number.isFinite(node) ? node : undefined;
    if (node && typeof node === 'object' && 'raw' in (node as Record<string, unknown>)) {
        const r = (node as { raw?: unknown }).raw;
        return typeof r === 'number' && Number.isFinite(r) ? r : undefined;
    }
    return undefined;
}

/** Pull next-earnings + dividend dates (UTC ms) out of a Yahoo `calendarEvents` module payload. */
export function extractEarningsInfo(calendarEvents: unknown): EarningsInfo {
    const ce = calendarEvents as Record<string, unknown> | undefined;
    const earnings = ce?.['earnings'] as Record<string, unknown> | undefined;
    const dates = earnings?.['earningsDate'];
    const earningsSec = rawSeconds(Array.isArray(dates) ? dates[0] : undefined);
    const divSec = rawSeconds(ce?.['dividendDate']);
    const info: EarningsInfo = {};
    if (earningsSec !== undefined) info.nextEarningsDate = earningsSec * 1000;
    if (divSec !== undefined) info.dividendDate = divSec * 1000;
    return info;
}

export class YahooEarningsProvider implements EarningsProvider {
    constructor(
        private readonly qs: QuoteSummaryFetcher = new YahooQuoteSummary(),
        private readonly interRequestMs = 500,
    ) {}

    async fetch(tickers: string[]): Promise<Record<string, EarningsInfo>> {
        const out: Record<string, EarningsInfo> = {};
        for (const ticker of tickers) {
            try {
                const sym = toYahooSymbol(ticker);
                if (isBlacklisted(sym)) continue;
                const result = await this.qs.fetchModules(sym, MODULES);
                if (!result) continue;                          // 404 / unknown — omit
                const info = extractEarningsInfo(result['calendarEvents']);
                if (info.nextEarningsDate !== undefined || info.dividendDate !== undefined) {
                    out[ticker] = info;
                }
            } catch (err) {
                log.warn(`[earnings/yahoo] ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
            }
            if (this.interRequestMs > 0) await sleep(this.interRequestMs);
        }
        return out;
    }
}
