// Pick the next (soonest future) dividend ex-date from the corporate_actions dividend list. The
// EODHD feed records ex-dividend dates, most of which are historical, so this commonly returns
// undefined — which is the honest answer ("no upcoming dividend date known"), never a fabricated one.
// Kept pure + standalone so the next-date selection is unit-tested independently of Mongo.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The UTC ms (00:00 of the day) of the soonest ex-dividend date strictly after `now`, or undefined
 * when no stored dividend is in the future. `dates` are 'YYYY-MM-DD' ex-dates as stored in
 * corporate_actions; an unparseable date is skipped.
 */
export function nextDividendDateMs(dates: string[], now: number): number | undefined {
    let best: number | undefined;
    for (const d of dates) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
        if (m === null) continue;
        const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (!Number.isFinite(ms)) continue;
        // Include "today" (ex-date is the priced-in instant) — strictly past dates are skipped.
        if (ms + DAY_MS <= now) continue;
        if (best === undefined || ms < best) best = ms;
    }
    return best;
}
