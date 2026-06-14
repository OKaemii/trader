// IrCalendarEarningsProvider — Pipeline B of the analyst-free estimates engine (plan
// analyst-free-estimates-engine.md ## Task 11). Sources FUTURE EXPECTED earnings dates from company
// IR calendars / press / exchange-announcement pages by rendering them through the Firecrawl scrape
// stack (homeserver, default http://192.168.50.2:3002), parsing the next earnings date out of the
// rendered markdown, and returning it as the existing `EarningsInfo` (so the store/scheduler/overlap/
// routes are unchanged). It is the default `EARNINGS_PROVIDER`, replacing StubEarningsProvider.
//
// DEDICATED calendar source — never extrapolated from filing cadence (the plan's binding "the three
// pipelines are decoupled" rule). `dividendDate` is NOT scraped: it continues to come from the EODHD
// `corporate_actions` dividends, injected here as a lookup callable so this provider stays decoupled
// from the corporate-actions store.
//
// Honest, fail-closed by construction:
//   * Firecrawl unreachable / 5xx / timeout / malformed JSON  → that ticker is OMITTED (no guess).
//   * Page renders but carries no future earnings date         → OMITTED (degrade-to-empty).
//   * No IR target configured for a ticker                     → OMITTED.
// An omitted ticker leaves the store untouched and the overlap detector at `within:false` — never a
// false "reports soon" flag. `confidence` records how the date was sourced (best-effort scraping).

import { setTimeout as sleep } from 'node:timers/promises';
import type { EarningsProvider, EarningsInfo } from './EarningsProvider.ts';
import { parseNextEarningsDate } from './ir-calendar-parse.ts';
import { IR_CALENDAR_TARGETS } from './ir-calendar-targets.ts';
import { log } from '../../../logger.ts';

// One IR/press/exchange page to render for a ticker. `name` is a short, stable provenance label that
// flows into the calendar doc's `source` (e.g. 'investor.apple.com'); `confidenceCap` lets a less
// reliable source (a third-party aggregator) cap the per-date confidence below the parser's score.
export interface IrTarget {
    url: string;
    name: string;
    confidenceCap?: number | undefined;   // 0..1 — clamp the parsed confidence for a less-trusted source
}

// The single field of a Firecrawl /v1/scrape response we read. Firecrawl returns
// { success, data: { markdown, metadata: { statusCode, ... } } }; we treat anything else as a miss.
export interface FirecrawlScrapeResult {
    markdown: string;
    statusCode?: number | undefined;
}

// Injectable scrape seam — the real one POSTs to Firecrawl; tests pass a fixture-backed fn so the
// parser/omit logic is exercised with no network. Returns null on any failure (degrade-to-empty).
export type ScrapeFn = (url: string) => Promise<FirecrawlScrapeResult | null>;

// Next dividend date (UTC ms) for a ticker, or undefined when none is known. Injected from the
// corporate_actions store so this provider does not import it (decoupled pipelines).
export type DividendDateLookup = (ticker: string) => Promise<number | undefined> | (number | undefined);

export interface IrCalendarEarningsProviderOpts {
    firecrawlBaseUrl: string;
    /** Per-ticker IR/press targets. Defaults to the built-in curated US map. */
    targets?: Record<string, IrTarget[]> | undefined;
    /** Pause between successive Firecrawl scrapes (rate-friendliness). Default 500ms. */
    requestSpacingMs?: number | undefined;
    /** Per-scrape timeout. Firecrawl renders can be slow; default 20s. */
    scrapeTimeoutMs?: number | undefined;
    /** Injected dividend-date source (corporate_actions). Default: always undefined (no dividend date). */
    dividendDateLookup?: DividendDateLookup | undefined;
    /** Injected scrape fn (tests). Default: a real Firecrawl POST. */
    scrape?: ScrapeFn | undefined;
    /** Clock seam for testing the future-only filter. Default Date.now. */
    now?: (() => number) | undefined;
}

export class IrCalendarEarningsProvider implements EarningsProvider {
    private readonly targets: Record<string, IrTarget[]>;
    private readonly requestSpacingMs: number;
    private readonly scrapeTimeoutMs: number;
    private readonly dividendDateLookup: DividendDateLookup;
    private readonly scrapeFn: ScrapeFn;
    private readonly now: () => number;
    private readonly firecrawlBaseUrl: string;

    constructor(opts: IrCalendarEarningsProviderOpts) {
        this.firecrawlBaseUrl = opts.firecrawlBaseUrl.replace(/\/+$/, '');
        this.targets = opts.targets ?? IR_CALENDAR_TARGETS;
        this.requestSpacingMs = opts.requestSpacingMs ?? 500;
        this.scrapeTimeoutMs = opts.scrapeTimeoutMs ?? 20_000;
        this.dividendDateLookup = opts.dividendDateLookup ?? (() => undefined);
        this.scrapeFn = opts.scrape ?? ((url) => this.firecrawlScrape(url));
        this.now = opts.now ?? Date.now;
    }

    /**
     * Resolve next-earnings + next-dividend for each ticker. A ticker is included in the result ONLY
     * when at least one of the two dates is known — an all-miss ticker is omitted (the contract), so
     * the store accretes nothing and overlap stays `within:false`.
     */
    async fetch(tickers: string[]): Promise<Record<string, EarningsInfo>> {
        const out: Record<string, EarningsInfo> = {};
        let scrapedAny = false;
        for (const ticker of tickers) {
            // Space out scrapes only between real Firecrawl calls (a ticker with no target is free).
            const targets = this.targets[ticker] ?? [];
            if (scrapedAny && targets.length > 0) await sleep(this.requestSpacingMs);

            const earnings = targets.length > 0 ? await this.resolveEarnings(ticker, targets) : null;
            if (targets.length > 0) scrapedAny = true;

            let dividendDate: number | undefined;
            try { dividendDate = await this.dividendDateLookup(ticker); }
            catch (err) {
                log.warn(`[earnings] dividend lookup failed for ${ticker}: ${err instanceof Error ? err.message : String(err)}`);
            }

            if (earnings === null && dividendDate === undefined) continue;   // all-miss → omit
            const info: EarningsInfo = {};
            if (earnings !== null) {
                info.nextEarningsDate = earnings.dateMs;
                info.source = earnings.source;
                info.confidence = earnings.confidence;
            }
            if (dividendDate !== undefined) info.dividendDate = dividendDate;
            out[ticker] = info;
        }
        return out;
    }

    // Scrape the ticker's IR targets in order; take the SOONEST future earnings date found across
    // them. Each target's scrape failure is isolated (a dead URL doesn't lose the others). Returns
    // null when no target yields a future earnings date.
    private async resolveEarnings(
        ticker: string,
        targets: IrTarget[],
    ): Promise<{ dateMs: number; source: string; confidence: number } | null> {
        const now = this.now();
        let best: { dateMs: number; source: string; confidence: number } | null = null;
        for (const target of targets) {
            const result = await this.scrapeFn(target.url);
            if (result === null) continue;                              // scrape miss → next target
            const parsed = parseNextEarningsDate(result.markdown, now);
            if (parsed === null) continue;                              // no future earnings date
            const confidence = Math.min(parsed.confidence, target.confidenceCap ?? 1);
            if (best === null || parsed.dateMs < best.dateMs) {
                best = { dateMs: parsed.dateMs, source: `ir-calendar:${target.name}`, confidence };
            }
        }
        return best;
    }

    // The real Firecrawl scrape. POST /v1/scrape { url, formats:['markdown'] } → { data:{ markdown } }.
    // Returns null (never throws) on timeout / non-2xx / transport error / malformed body so the
    // caller degrades to empty for that ticker.
    private async firecrawlScrape(url: string): Promise<FirecrawlScrapeResult | null> {
        try {
            const res = await fetch(`${this.firecrawlBaseUrl}/v1/scrape`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
                signal: AbortSignal.timeout(this.scrapeTimeoutMs),
            });
            if (!res.ok) { log.warn(`[earnings] firecrawl HTTP ${res.status} for ${url}`); return null; }
            const body = (await res.json()) as { success?: boolean; data?: { markdown?: string; metadata?: { statusCode?: number } } };
            if (body.success !== true || typeof body.data?.markdown !== 'string') {
                log.warn(`[earnings] firecrawl returned no markdown for ${url}`);
                return null;
            }
            return { markdown: body.data.markdown, statusCode: body.data.metadata?.statusCode };
        } catch (err) {
            log.warn(`[earnings] firecrawl scrape failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
}
