// Pure earnings-overlap: of a set of position tickers, which report within N days. Kept pure so
// the "holding reports soon" flag — the biggest avoidable swing-trade disaster — is unit-tested
// independently of Mongo. Unknown coverage passes through as within:false: never a false flag,
// and never a false "no earnings soon".

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EarningsOverlap {
    ticker: string;
    nextEarningsDate: number | null;   // UTC ms, or null if unknown
    daysUntil: number | null;          // calendar days from `now`; null if unknown; negative if past
    within: boolean;                   // reports in [0, withinDays] days (inclusive)
}

export function earningsOverlap(
    tickers: string[],
    byTicker: Record<string, { nextEarningsDate?: number | undefined }>,
    now: number,
    withinDays = 10,
): EarningsOverlap[] {
    return tickers.map((ticker) => {
        const date = byTicker[ticker]?.nextEarningsDate;
        if (date == null) return { ticker, nextEarningsDate: null, daysUntil: null, within: false };
        const daysUntil = (date - now) / DAY_MS;
        return { ticker, nextEarningsDate: date, daysUntil, within: daysUntil >= 0 && daysUntil <= withinDays };
    });
}
