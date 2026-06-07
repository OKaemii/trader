// Data-grounded hybrid market narrative (locked decision #8). The pipeline:
//   1. A templated-NLG SKELETON is built that already contains EVERY number from the T29 market
//      summary payload, each rendered to a FIXED precision. The set of those rendered figure-strings
//      is the ONLY numbers the prose may contain — `buildNarrativeFigures` returns both the skeleton
//      and that allow-set.
//   2. The skeleton + the raw summary are handed to the LLM as STRUCTURED CONTEXT; it returns fluent
//      prose CONSTRAINED to restate/interpret those numbers (the prompt forbids inventing figures).
//   3. A POST-CHECK (`narrativeFiguresAllowed`) tokenises every numeric figure in the LLM prose and
//      rejects the output if ANY figure is not in the allow-set. On rejection (or LLM error / empty
//      output) we serve the deterministic skeleton — the page is NEVER blocked.
//
// This file is PURE: no Mongo, no Redis, no network. The route owns the summary fetch + LLM call +
// caching; this owns the maths of "what may the prose say" and the deterministic fallback prose, so
// the load-bearing guarantee — narrative numbers ⊆ summary payload — is unit-tested in isolation.

import type { MarketSummary } from './MarketSummary.ts';

export type NarrativeSource = 'llm' | 'template';

export interface NarrativeFigures {
    /** The deterministic template prose — every number, no interpretation. Also the LLM-failure fallback. */
    skeleton: string;
    /**
     * Every figure-string the prose is allowed to contain, rendered EXACTLY as the skeleton renders
     * them (so the post-check compares the same surface form the model is shown). The post-check
     * accepts a numeric token iff its normalised form is in this set.
     */
    allowed: Set<string>;
}

// ---- Number formatting (the single source of "how a figure looks") ---------------------------
// Every number that leaves this module is rendered through one of these. The post-check tokenises
// the LLM prose and compares against the SAME rendered forms, so the model can only echo figures we
// produced — there is no second formatting convention for it to drift into.

/** A percentage point value (e.g. a weekly return 0.0523 → "5.23%"). One sign, two decimals. */
function fmtPctPoints(fraction: number): string {
    return `${(fraction * 100).toFixed(2)}%`;
}

/** A percentile or breadth fraction already in [0,1] → whole-number percent (e.g. 0.62 → "62%"). */
function fmtPct0(fraction: number): string {
    return `${(fraction * 100).toFixed(0)}%`;
}

/** A factor cross-sectional percentile mean, already in [0,100] (e.g. 58.3 → "58.3"). */
function fmtPercentile(v: number): string {
    return v.toFixed(1);
}

/** A z-score / HHI-style raw number → three decimals (e.g. 0.2473 → "0.247"). */
function fmt3(v: number): string {
    return v.toFixed(3);
}

/** A plain count. */
function fmtInt(v: number): string {
    return String(Math.trunc(v));
}

// Canonicalise a figure-string for set membership: strip a leading '+', drop a trailing '%', so the
// comparison is on the magnitude+precision the formatters produced. ("5.23%" → "5.23", "-1.00%" →
// "-1.00", "62%" → "62", "0.247" → "0.247", "12" → "12").
function canon(figure: string): string {
    return figure.replace(/^\+/, '').replace(/%$/, '');
}

// Human label for a factor key.
const FACTOR_LABEL: Record<string, string> = {
    momentum:   'momentum',
    volatility: 'low-volatility',
    value:      'value',
    quality:    'quality',
};

// ---- Skeleton + allow-set --------------------------------------------------------------------

/**
 * Build the deterministic template skeleton + the allow-set of figure-strings. Pure: same summary ⇒
 * byte-for-byte same skeleton + allow-set. Tolerates the pre-first-cycle case where factorLeadership
 * legs and breadth are null (the T29 contract — factor_scores empty until strategy-engine's first
 * cycle): those legs render as "not yet computed" with NO number, so they contribute nothing to the
 * allow-set and the prose can't cite a figure that doesn't exist.
 */
export function buildNarrativeFigures(summary: MarketSummary): NarrativeFigures {
    const allowed = new Set<string>();
    const add = (figure: string): string => {
        allowed.add(canon(figure));
        return figure;
    };

    // Structural vocabulary the skeleton phrases with — NOT data figures, but they appear as bare
    // numerals ("200-day moving average") the LLM legitimately echoes, so they must be in the
    // allow-set or the post-check would reject our own skeleton's wording. 200 = the DMA period.
    add('200');

    const lines: string[] = [];

    // — Sectors —
    const rankedSectors = summary.sectorReturns.filter((s) => s.latest !== null);
    if (rankedSectors.length > 0) {
        const lead = rankedSectors[0]!;
        const lag  = rankedSectors[rankedSectors.length - 1]!;
        const leadFig = add(fmtPctPoints(lead.latest!));
        if (rankedSectors.length === 1) {
            lines.push(`${lead.sector} posted a ${leadFig} latest-week return.`);
        } else {
            const lagFig = add(fmtPctPoints(lag.latest!));
            lines.push(
                `Sector leadership: ${lead.sector} led the latest week at ${leadFig}, ` +
                `with ${lag.sector} the laggard at ${lagFig}.`,
            );
        }
    } else {
        lines.push('Sector latest-week returns are not yet available (insufficient weekly history).');
    }

    // — Factor leadership — (always all four; null legs render without a number)
    const factorParts: string[] = [];
    for (const leg of summary.factorLeadership) {
        const label = FACTOR_LABEL[leg.factor] ?? leg.factor;
        if (leg.meanPct === null || leg.count === 0) {
            factorParts.push(`${label} is not yet computed`);
            continue;
        }
        const pctFig   = add(fmtPercentile(leg.meanPct));
        const countFig = add(fmtInt(leg.count));
        factorParts.push(`${label} averages a ${pctFig} cross-sectional percentile across ${countFig} names`);
    }
    lines.push(`Factor leadership — ${factorParts.join('; ')}.`);

    // — Breadth —
    if (summary.breadth.pctAbove200dma === null) {
        lines.push('Breadth above the 200-day moving average is not yet available (no name has enough daily history).');
    } else {
        const pctFig   = add(fmtPct0(summary.breadth.pctAbove200dma));
        const aboveFig = add(fmtInt(summary.breadth.aboveCount));
        const totalFig = add(fmtInt(summary.breadth.totalWithHistory));
        lines.push(`Breadth: ${pctFig} of names (${aboveFig} of ${totalFig} with sufficient history) trade above their 200-day average.`);
    }

    // — Concentration —
    const conc = summary.concentration;
    if (conc.hhi === null) {
        lines.push('Portfolio concentration is not available (no current positions).');
    } else {
        const hhiFig   = add(fmt3(conc.hhi));
        const countFig = add(fmtInt(conc.positionCount));
        if (conc.targetHhi !== null && conc.excess !== null) {
            const targetFig = add(fmt3(conc.targetHhi));
            const excessFig = add(fmt3(conc.excess));
            const direction = conc.excess > 0 ? 'above' : conc.excess < 0 ? 'below' : 'at';
            lines.push(
                `Concentration: HHI is ${hhiFig} across ${countFig} positions, ${excessFig} ${direction} ` +
                `the ${targetFig} equal-weight target.`,
            );
        } else {
            lines.push(`Concentration: HHI is ${hhiFig} across ${countFig} positions.`);
        }
    }

    return { skeleton: lines.join(' '), allowed };
}

// ---- Post-check: every numeric figure in the prose must be in the allow-set -------------------

// Matches a signed decimal-or-integer figure with an optional trailing '%'. Captures e.g. "5.23%",
// "-1.00%", "62%", "0.247", "12", "58.3". A bare 4-digit-or-more run with no decimal (a year, a
// count of bars) is still a number — the allow-set holds the counts the payload exposes, so a stray
// "2026" the model invents is correctly rejected.
const FIGURE_RE = /[+-]?\d+(?:\.\d+)?%?/g;

/**
 * True iff EVERY numeric figure in `prose` is in `allowed`. The load-bearing guarantee: a passing
 * narrative cites only numbers the summary payload exposes. Prose with no figures at all trivially
 * passes (it cited nothing it shouldn't) — but in practice the LLM is asked to restate the numbers.
 */
export function narrativeFiguresAllowed(prose: string, allowed: Set<string>): boolean {
    const matches = prose.match(FIGURE_RE);
    if (!matches) return true;
    for (const m of matches) {
        if (!allowed.has(canon(m))) return false;
    }
    return true;
}

// ---- LLM prompt --------------------------------------------------------------------------------

/**
 * Build the LLM prompt: ONLY the deterministic skeleton (already carrying every number, each in the
 * exact rendered form the post-check allows) + a clean AS-OF label, with HARD RULES that forbid
 * inventing figures. The model's job is to make the skeleton read fluently, not to add data.
 *
 * Deliberately NOT the raw summary JSON: that JSON carries figures the skeleton does NOT (the asOf
 * epoch-ms, raw return fractions like 0.0523, meanRaw z-scores), none of which are in the post-check
 * allow-set — so a faithful model echoing them would trip the post-check and bounce to the template.
 * The skeleton is the single source of permitted figures, so it is the only context the model gets.
 */
export function buildNarrativePrompt(summary: MarketSummary, skeleton: string): string {
    const asOfLabel = summary.asOf === null ? 'pre-first-cycle (no factor scores yet)'
        : new Date(summary.asOf).toISOString().slice(0, 10);
    return `You are a buy-side strategist writing a one-paragraph market-state read for a quant operator.

AS OF: ${asOfLabel}

DETERMINISTIC SKELETON (this is the COMPLETE set of facts and the ONLY numbers that exist — rewrite it into fluent prose, do NOT add, change, or derive any figure):
${skeleton}

WRITE one tight paragraph (3–5 sentences) that reads naturally while restating the skeleton's facts.

HARD RULES:
- NEVER write a number that is not already in the skeleton above. Every figure must appear there verbatim.
- Do not compute, round differently, annualise, or derive any new number. If the skeleton says "5.23%", write "5.23%".
- If a field is "not yet computed" / "not yet available", say so in words — do NOT invent a value for it.
- No bullet points, no markdown, no headers. Plain prose only.
- Do not editorialise with filler adjectives ("robust", "healthy", "solid"); let the numbers carry the read.`;
}

// ---- Orchestration (still pure — the LLM call is injected) -------------------------------------

export interface NarrativeResult {
    narrative: string;
    source:    NarrativeSource;
}

/** Anything with `.chat(req)` — the injected LLM seam (DeepSeekClient in prod, a stub in tests). */
export interface NarrativeChat {
    chat(req: { messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>; maxTokens?: number; temperature?: number }): Promise<string>;
}

/**
 * Produce the day's narrative. Builds the deterministic skeleton, asks the LLM (if any) to phrase it,
 * post-checks the result's figures ⊆ the allow-set, and falls back to the skeleton when the LLM is
 * absent, errors, returns empty, or invents a figure. NEVER throws — the page is never blocked.
 *
 * `logWarn` (optional) is called with the reason a generated LLM narrative was rejected, so an
 * operator can see "LLM invented a figure" in the logs without it ever reaching the page.
 */
export async function generateNarrative(
    summary: MarketSummary,
    llm: NarrativeChat | null,
    logWarn?: (reason: string, detail?: Record<string, unknown>) => void,
): Promise<NarrativeResult> {
    const { skeleton, allowed } = buildNarrativeFigures(summary);
    if (!llm) return { narrative: skeleton, source: 'template' };

    let prose = '';
    try {
        prose = (await llm.chat({
            messages:    [{ role: 'user', content: buildNarrativePrompt(summary, skeleton) }],
            maxTokens:   500,
            temperature: 0.3,
        })).trim();
    } catch (err) {
        logWarn?.('llm_error', { error: err instanceof Error ? err.message : String(err) });
        return { narrative: skeleton, source: 'template' };
    }

    if (!prose) {
        logWarn?.('llm_empty');
        return { narrative: skeleton, source: 'template' };
    }
    if (!narrativeFiguresAllowed(prose, allowed)) {
        // The model cited a figure not in the payload — the exact failure decision #8 guards against.
        logWarn?.('llm_invented_figure');
        return { narrative: skeleton, source: 'template' };
    }
    return { narrative: prose, source: 'llm' };
}
