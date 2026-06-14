// Earnings composition root. Selects the earnings/dividend-date provider via EARNINGS_PROVIDER:
//   * 'ir_calendar' (default) — IrCalendarEarningsProvider: future expected earnings dates scraped
//     from company IR/press pages through Firecrawl (Pipeline B of the analyst-free estimates
//     engine), with the dividend date supplied from the EODHD corporate_actions feed (injected).
//   * 'stub' — StubEarningsProvider: returns no dates, so the overlap detector stays a clean no-op
//     (the pre-Pipeline-B behaviour; kept selectable for tests / a Firecrawl-down fallback).
// The store/scheduler/overlap/routes are unchanged across the swap.

import { EarningsStore } from './application/EarningsStore.ts';
import { StubEarningsProvider } from './infrastructure/StubEarningsProvider.ts';
import { IrCalendarEarningsProvider, type DividendDateLookup } from './infrastructure/IrCalendarEarningsProvider.ts';
import type { EarningsProvider } from './infrastructure/EarningsProvider.ts';
import { log } from '../../logger.ts';

export type EarningsProviderName = 'ir_calendar' | 'stub';

export interface BuildEarningsStoreOpts {
    /** Firecrawl scrape-stack base URL (homeserver). Required for the ir_calendar provider. */
    firecrawlBaseUrl?: string | undefined;
    /** Pause between successive Firecrawl scrapes (rate-friendliness). */
    requestSpacingMs?: number | undefined;
    /** Next dividend date (UTC ms) for a ticker from corporate_actions, injected so earnings stays
     *  decoupled from the corporate-actions store. Omitted ⇒ no dividend dates. */
    dividendDateLookup?: DividendDateLookup | undefined;
}

/**
 * Pure provider selection (no Mongo) so the env→provider wiring is unit-testable. Returns the chosen
 * provider + its coarse source stamp. `ir_calendar` requires a Firecrawl base URL — without one it
 * falls back to the no-op stub (a provider that can only ever miss is worse than an honest no-op).
 */
export function selectEarningsProvider(
    providerName: EarningsProviderName,
    opts: BuildEarningsStoreOpts = {},
): { provider: EarningsProvider; source: string } {
    if (providerName === 'ir_calendar' && opts.firecrawlBaseUrl) {
        const provider = new IrCalendarEarningsProvider({
            firecrawlBaseUrl: opts.firecrawlBaseUrl,
            requestSpacingMs: opts.requestSpacingMs,
            dividendDateLookup: opts.dividendDateLookup,
        });
        // Per-date provenance (`ir-calendar:<host>`) is stamped by the provider; this coarse stamp is
        // only the fallback the store uses if a date ever arrives without provenance.
        return { provider, source: 'ir-calendar' };
    }
    if (providerName === 'ir_calendar') {
        log.warn('[earnings] EARNINGS_PROVIDER=ir_calendar but no firecrawlBaseUrl configured; using the no-op stub');
    }
    // 'stub' (or ir_calendar with no scrape stack): the no-op provider.
    return { provider: new StubEarningsProvider(), source: 'stub' };
}

export function buildEarningsStore(
    providerName: EarningsProviderName,
    opts: BuildEarningsStoreOpts = {},
): EarningsStore {
    const { provider, source } = selectEarningsProvider(providerName, opts);
    return new EarningsStore(provider, source);
}
