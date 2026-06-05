// Earnings/dividend date source. Kept behind an interface so the Yahoo calendarEvents path can
// be swapped for a paid EODHD calendar later, and so the store/scheduler are unit-testable with a
// stub. A provider OMITS a ticker entirely when it has no date — it never guesses, so "unknown"
// stays distinguishable from "no earnings soon" downstream.

export interface EarningsInfo {
    nextEarningsDate?: number | undefined;   // UTC ms of the next scheduled earnings report
    dividendDate?: number | undefined;       // UTC ms of the next dividend date
}

export interface EarningsProvider {
    fetch(tickers: string[]): Promise<Record<string, EarningsInfo>>;
}
