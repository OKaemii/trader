// Pure parser for the IR-calendar earnings provider — kept separate from the Firecrawl I/O so the
// date-extraction logic (the fiddly, fixture-driven part) is unit-tested without a network mock.
//
// IR / press / exchange pages render the next expected earnings date in wildly varying prose — "Apple
// to announce third-quarter results on Thursday, July 31, 2026", "will report Q2 results on 30 April
// 2026", an ISO "2026-07-31" beside an upcoming-event marker. We therefore DON'T pin one selector: we
// scan the rendered markdown for any date token NEAR an earnings/results phrase and take the soonest
// FUTURE one. If nothing future + earnings-tagged is found we return null — the provider then omits
// the ticker (degrade-to-empty), never guessing (the "best-effort, honest confidence" rule from the
// plan's Pipeline B).

const MONTHS: Record<string, number> = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Words that, when present on the SAME markdown line as a date, mark that date as an earnings/results
// event rather than an unrelated date (a copyright year, a dividend record date, a software release).
const EARNINGS_CONTEXT = /\b(earnings|results|quarter|fiscal|q[1-4]\b|conference call|webcast|report(?:s|ing)?|announce)/i;

// Phrasings that specifically denote a FUTURE/expected event (vs. "reported" / "announced results
// for the quarter ended"). Used only to lift confidence — a future-dated earnings line already
// qualifies; this just distinguishes "to announce … on <future date>" (high) from a bare future date
// on an earnings line (lower).
const FUTURE_PHRASE = /\b(to announce|will (?:report|host|release|announce)|scheduled|upcoming|to be held|to report|expected)/i;

// Three date shapes, each capturing into named-ish groups via index.
//   1) "July 31, 2026" / "Jul 31 2026"            (month name first)
//   2) "31 July 2026" / "30 April, 2026"          (day first)
//   3) "2026-07-31"                               (ISO)
const RE_MONTH_DAY_YEAR = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g;
const RE_DAY_MONTH_YEAR = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/g;
const RE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

export interface ParsedEarningsDate {
    /** UTC ms at 00:00 of the parsed calendar day. */
    dateMs: number;
    /** 0..1 — higher when the line carries an explicit "to announce …" future phrasing. */
    confidence: number;
}

function utcMsOf(year: number, monthIdx: number, day: number): number | null {
    if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
    const ms = Date.UTC(year, monthIdx, day);
    const d = new Date(ms);
    // Reject overflow (e.g. Feb 31 rolled into March) so a malformed date never becomes a real one.
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIdx || d.getUTCDate() !== day) return null;
    return ms;
}

// Extract every (dateMs, future-phrase?) candidate from one markdown line that carries an earnings
// context word. A line without that context yields nothing (a copyright "2026" is ignored). The
// future-phrase check runs over `contextText` (the line plus its immediate neighbours) because IR
// prose routinely wraps "… will report results on" onto the line ABOVE the date — checking only the
// date's own line would miss the verb and under-score the confidence.
function candidatesFromLine(line: string, contextText: string): Array<{ dateMs: number; future: boolean }> {
    if (!EARNINGS_CONTEXT.test(line)) return [];
    const future = FUTURE_PHRASE.test(contextText);
    const out: Array<{ dateMs: number; future: boolean }> = [];
    const push = (ms: number | null) => { if (ms !== null) out.push({ dateMs: ms, future }); };

    for (const m of line.matchAll(RE_MONTH_DAY_YEAR)) {
        const mon = MONTHS[m[1]!.toLowerCase()];
        if (mon === undefined) continue;            // a 3–9 letter word that isn't a month
        push(utcMsOf(Number(m[3]), mon, Number(m[2])));
    }
    for (const m of line.matchAll(RE_DAY_MONTH_YEAR)) {
        const mon = MONTHS[m[2]!.toLowerCase()];
        if (mon === undefined) continue;
        push(utcMsOf(Number(m[3]), mon, Number(m[1])));
    }
    for (const m of line.matchAll(RE_ISO)) {
        push(utcMsOf(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    }
    return out;
}

/**
 * Find the next expected earnings date in scraped IR/press markdown.
 *
 * Returns the SOONEST date that is (a) strictly in the future relative to `now` and (b) on a line
 * carrying an earnings/results context word. `confidence` is 0.8 when that line also carries an
 * explicit future phrasing ("to announce … on <date>"), else 0.5 (a future earnings date with no
 * verb — plausible but weaker). Returns `null` when no qualifying future date exists, so the caller
 * omits the ticker (degrade-to-empty — never a guessed date).
 */
export function parseNextEarningsDate(markdown: string, now: number): ParsedEarningsDate | null {
    if (!markdown) return null;
    const lines = markdown.split('\n');
    let best: { dateMs: number; future: boolean } | null = null;
    for (let i = 0; i < lines.length; i++) {
        // The future-phrase context: this line + its two neighbours, so a verb wrapped onto an
        // adjacent line still counts. The earnings-context + date extraction stay on the line itself.
        const contextText = `${lines[i - 1] ?? ''} ${lines[i]} ${lines[i + 1] ?? ''}`;
        for (const cand of candidatesFromLine(lines[i]!, contextText)) {
            if (cand.dateMs <= now) continue;               // future-only
            if (best === null || cand.dateMs < best.dateMs) best = cand;
        }
    }
    if (best === null) return null;
    return { dateMs: best.dateMs, confidence: best.future ? 0.8 : 0.5 };
}
