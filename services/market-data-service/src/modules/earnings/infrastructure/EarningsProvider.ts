// Earnings/dividend date source. Kept behind an interface so a provider (the no-op stub, or the
// IR-calendar Firecrawl provider) can be swapped without touching the store/scheduler/routes, and so
// they stay unit-testable with a stub. A provider OMITS a ticker entirely when it has no date — it
// never guesses, so "unknown" stays distinguishable from "no earnings soon" downstream (the overlap
// detector then reports `within:false` for that name, never a false flag).

export interface EarningsInfo {
    nextEarningsDate?: number | undefined;   // UTC ms of the next scheduled earnings report
    dividendDate?: number | undefined;       // UTC ms of the next dividend date
    // Per-ticker provenance for the next-earnings date, persisted on the calendar doc so the read
    // surfaces can show HOW the date was sourced and HOW reliable it is (IR scraping is best-effort).
    // Omitted by providers that have no date for the ticker; the stub never sets either. The store
    // stamps a coarse fallback `source` when a provider supplies a date without one.
    source?: string | undefined;             // e.g. 'ir-calendar:investor.apple.com'
    confidence?: number | undefined;         // 0..1 — source reliability for THIS date
}

export interface EarningsProvider {
    fetch(tickers: string[]): Promise<Record<string, EarningsInfo>>;
}
