// Earnings/dividend date source. Kept behind an interface so the current no-op stub (decision I —
// the Yahoo source was dropped) can be swapped for a PIT-backed calendar later, and so the
// store/scheduler stay unit-testable with a stub. A provider OMITS a ticker entirely when it has no
// date — it never guesses, so "unknown" stays distinguishable from "no earnings soon" downstream.

export interface EarningsInfo {
    nextEarningsDate?: number | undefined;   // UTC ms of the next scheduled earnings report
    dividendDate?: number | undefined;       // UTC ms of the next dividend date
}

export interface EarningsProvider {
    fetch(tickers: string[]): Promise<Record<string, EarningsInfo>>;
}
