import { describe, it, expect } from 'vitest';
import {
    buildNarrativeFigures,
    narrativeFiguresAllowed,
    generateNarrative,
    type NarrativeChat,
} from '../modules/research/application/MarketNarrative.ts';
import type { MarketSummary } from '../modules/research/application/MarketSummary.ts';

// A fully-populated summary fixture (post-first-cycle): every leg carries a number, so the prose has
// the maximal set of figures to (correctly or incorrectly) cite.
function fullSummary(over: Partial<MarketSummary> = {}): MarketSummary {
    return {
        asOf: 1_717_700_000_000,
        sectorReturns: [
            { sector: 'Technology', ticker: 'XLK_US_EQ', latest: 0.0523 },
            { sector: 'Energy',     ticker: 'XLE_US_EQ', latest: 0.0118 },
            { sector: 'Financials', ticker: 'XLF_US_EQ', latest: -0.0107 },
        ],
        factorLeadership: [
            { factor: 'momentum',   meanPct: 58.34, meanRaw: 0.41,  count: 42 },
            { factor: 'volatility', meanPct: 49.10, meanRaw: -0.02, count: 42 },
            { factor: 'value',      meanPct: 51.77, meanRaw: 0.08,  count: 30 },
            { factor: 'quality',    meanPct: 55.02, meanRaw: 0.19,  count: 28 },
        ],
        breadth: { pctAbove200dma: 0.62, aboveCount: 26, totalWithHistory: 42 },
        concentration: { hhi: 0.2473, targetHhi: 0.05, excess: 0.1973, positionCount: 18 },
        ...over,
    };
}

// The pre-first-cycle summary the T29 contract guarantees: factor_scores empty ⇒ factorLeadership
// legs null/count 0, breadth null, asOf null. Sector returns + concentration may still populate.
function preFirstCycleSummary(): MarketSummary {
    return {
        asOf: null,
        sectorReturns: [
            { sector: 'Technology', ticker: 'XLK_US_EQ', latest: 0.0312 },
            { sector: 'Utilities',  ticker: 'XLU_US_EQ', latest: null },
        ],
        factorLeadership: [
            { factor: 'momentum',   meanPct: null, meanRaw: null, count: 0 },
            { factor: 'volatility', meanPct: null, meanRaw: null, count: 0 },
            { factor: 'value',      meanPct: null, meanRaw: null, count: 0 },
            { factor: 'quality',    meanPct: null, meanRaw: null, count: 0 },
        ],
        breadth: { pctAbove200dma: null, aboveCount: 0, totalWithHistory: 0 },
        concentration: { hhi: null, targetHhi: 0.05, excess: null, positionCount: 0 },
    };
}

// Pull every numeric figure out of a string the way the post-check does — used to assert the
// load-bearing guarantee from the test side, independently of the production regex.
function figuresIn(s: string): string[] {
    return (s.match(/[+-]?\d+(?:\.\d+)?%?/g) ?? []).map((m) => m.replace(/^\+/, '').replace(/%$/, ''));
}

describe('buildNarrativeFigures — deterministic skeleton', () => {
    it('renders every payload number into the skeleton, byte-for-byte stable', () => {
        const s = fullSummary();
        const a = buildNarrativeFigures(s);
        const b = buildNarrativeFigures(s);
        expect(a.skeleton).toBe(b.skeleton);
        // The skeleton cites the lead + lag sector returns, the four factor percentiles + counts,
        // breadth, and the concentration triple — spot-check the load-bearing ones are present.
        expect(a.skeleton).toContain('5.23%');   // Technology lead
        expect(a.skeleton).toContain('-1.07%');  // Financials lag
        expect(a.skeleton).toContain('58.3');    // momentum percentile
        expect(a.skeleton).toContain('62%');     // breadth
        expect(a.skeleton).toContain('0.247');   // HHI
        expect(a.skeleton).toContain('0.197');   // excess
    });

    it('the skeleton itself only contains figures in its OWN allow-set (self-consistency)', () => {
        const { skeleton, allowed } = buildNarrativeFigures(fullSummary());
        for (const fig of figuresIn(skeleton)) {
            expect(allowed.has(fig)).toBe(true);
        }
        // and the production post-check agrees
        expect(narrativeFiguresAllowed(skeleton, allowed)).toBe(true);
    });

    it('tolerates the pre-first-cycle null/empty factor + breadth case without inventing numbers', () => {
        const { skeleton, allowed } = buildNarrativeFigures(preFirstCycleSummary());
        // null legs render as words, not numbers
        expect(skeleton).toContain('not yet computed');
        expect(skeleton).toContain('Breadth above the 200-day moving average is not yet available');
        // no position ⇒ concentration phrased without a number
        expect(skeleton).toContain('Portfolio concentration is not available');
        // The only DATA figure is the one sector return that exists (3.12%); the only other numeral
        // is the structural "200" (the 200-day MA period the phrasing references). No fabricated zeros
        // for the null factor/breadth/concentration legs.
        expect(figuresIn(skeleton).sort()).toEqual(['200', '3.12']);
        expect(allowed.has('3.12')).toBe(true);
        expect(narrativeFiguresAllowed(skeleton, allowed)).toBe(true);
    });
});

describe('narrativeFiguresAllowed — the load-bearing post-check', () => {
    it('passes prose whose figures are all in the payload', () => {
        const { allowed } = buildNarrativeFigures(fullSummary());
        const prose = 'Technology led at 5.23% while Financials lagged at -1.07%; momentum sits at the 58.3 percentile and breadth is 62%. HHI of 0.247 sits 0.197 above target.';
        expect(narrativeFiguresAllowed(prose, allowed)).toBe(true);
    });

    it('REJECTS prose citing a figure not in the payload (a hallucinated number)', () => {
        const { allowed } = buildNarrativeFigures(fullSummary());
        // 7.99% is not anywhere in the summary — the exact failure decision #8 guards against.
        const prose = 'Technology surged 7.99% on the week.';
        expect(narrativeFiguresAllowed(prose, allowed)).toBe(false);
    });

    it('REJECTS a re-rounded figure (5.2% vs the skeleton 5.23%)', () => {
        const { allowed } = buildNarrativeFigures(fullSummary());
        expect(narrativeFiguresAllowed('Technology rose 5.2% this week.', allowed)).toBe(false);
    });

    it('passes prose with no figures at all', () => {
        const { allowed } = buildNarrativeFigures(fullSummary());
        expect(narrativeFiguresAllowed('Markets were quiet with no notable moves.', allowed)).toBe(true);
    });

    it('rejects an invented year/count even when other figures are valid', () => {
        const { allowed } = buildNarrativeFigures(fullSummary());
        expect(narrativeFiguresAllowed('As of 2025, momentum sits at 58.3.', allowed)).toBe(false);
    });
});

describe('generateNarrative — hybrid orchestration', () => {
    const okLlm = (text: string): NarrativeChat => ({ chat: async () => text });

    it('returns the deterministic template when no LLM is configured', async () => {
        const summary = fullSummary();
        const res = await generateNarrative(summary, null);
        expect(res.source).toBe('template');
        expect(res.narrative).toBe(buildNarrativeFigures(summary).skeleton);
    });

    it('returns the LLM prose (source=llm) when its figures are all in the payload', async () => {
        const summary = fullSummary();
        const prose = 'Technology led at 5.23%, momentum sits near the 58.3 percentile, breadth is 62%.';
        const res = await generateNarrative(summary, okLlm(prose));
        expect(res.source).toBe('llm');
        expect(res.narrative).toBe(prose);
        // LOAD-BEARING: every figure in the served narrative is in the summary payload's number-set
        const { allowed } = buildNarrativeFigures(summary);
        for (const fig of figuresIn(res.narrative)) {
            expect(allowed.has(fig)).toBe(true);
        }
    });

    it('falls back to the template when the LLM invents a figure', async () => {
        const summary = fullSummary();
        const reasons: string[] = [];
        const res = await generateNarrative(
            summary,
            okLlm('Technology exploded 9.99% on heavy volume.'),
            (reason) => reasons.push(reason),
        );
        expect(res.source).toBe('template');
        expect(res.narrative).toBe(buildNarrativeFigures(summary).skeleton);
        expect(reasons).toContain('llm_invented_figure');
    });

    it('falls back to the template when the LLM errors (never blocks the page)', async () => {
        const summary = fullSummary();
        const boom: NarrativeChat = { chat: async () => { throw new Error('deepseek 503'); } };
        const reasons: string[] = [];
        const res = await generateNarrative(summary, boom, (reason) => reasons.push(reason));
        expect(res.source).toBe('template');
        expect(res.narrative).toBe(buildNarrativeFigures(summary).skeleton);
        expect(reasons).toContain('llm_error');
    });

    it('falls back to the template when the LLM returns empty', async () => {
        const summary = fullSummary();
        const res = await generateNarrative(summary, okLlm('   '));
        expect(res.source).toBe('template');
    });

    it('whatever the source, the served narrative numbers are ⊆ the summary payload', async () => {
        // Run the guarantee across the matrix: good LLM, hallucinating LLM, error, pre-first-cycle.
        for (const summary of [fullSummary(), preFirstCycleSummary()]) {
            const { allowed } = buildNarrativeFigures(summary);
            const candidates: Array<NarrativeChat | null> = [
                null,
                okLlm('Momentum sits at 58.3 and breadth is 62%.'),
                okLlm('Technology jumped 12.34% — a blowout.'),  // hallucination ⇒ fallback
            ];
            for (const llm of candidates) {
                const res = await generateNarrative(summary, llm);
                for (const fig of figuresIn(res.narrative)) {
                    expect(allowed.has(fig)).toBe(true);
                }
            }
        }
    });
});
