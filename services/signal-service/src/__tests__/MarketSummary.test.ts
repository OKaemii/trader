import { describe, it, expect } from 'vitest';
import {
    computeMarketSummary,
    FACTOR_KEYS,
    type FactorScoreRow,
    type MarketSummaryInput,
    type SectorReturnInput,
} from '../modules/research/application/MarketSummary.ts';

// A leg with both raw + pct present.
const leg = (raw: number | null, pct: number | null) => ({ raw, pct, source: 'eod' });

function row(ticker: string, f: Partial<Record<(typeof FACTOR_KEYS)[number], { raw: number | null; pct: number | null }>>): FactorScoreRow {
    const factors: FactorScoreRow['factors'] = {};
    for (const k of FACTOR_KEYS) {
        const v = f[k];
        if (v) factors[k] = { ...v, source: 'eod' };
    }
    return { ticker, factors };
}

function baseInput(over: Partial<MarketSummaryInput> = {}): MarketSummaryInput {
    return {
        sectorReturns: [],
        factorRows: [],
        factorCycleTs: null,
        breadthFlags: [],
        positionWeights: [],
        topK: 20,
        ...over,
    };
}

describe('computeMarketSummary — sector returns', () => {
    it('passes through sector rows sorted strongest-latest-first, nulls last', () => {
        const sectorReturns: SectorReturnInput[] = [
            { sector: 'Energy',     ticker: 'XLE_US_EQ', latest: 0.02 },
            { sector: 'Technology', ticker: 'XLK_US_EQ', latest: 0.05 },
            { sector: 'Utilities',  ticker: 'XLU_US_EQ', latest: null },
            { sector: 'Financials', ticker: 'XLF_US_EQ', latest: -0.01 },
        ];
        const out = computeMarketSummary(baseInput({ sectorReturns }));
        expect(out.sectorReturns.map((s) => s.ticker)).toEqual([
            'XLK_US_EQ', 'XLE_US_EQ', 'XLF_US_EQ', 'XLU_US_EQ',
        ]);
        expect(out.sectorReturns[0]).toEqual({ sector: 'Technology', ticker: 'XLK_US_EQ', latest: 0.05 });
    });

    it('breaks ties on latest return deterministically by ticker', () => {
        const sectorReturns: SectorReturnInput[] = [
            { sector: 'B', ticker: 'XLB_US_EQ', latest: 0.03 },
            { sector: 'A', ticker: 'XLA_US_EQ', latest: 0.03 },
        ];
        const out = computeMarketSummary(baseInput({ sectorReturns }));
        expect(out.sectorReturns.map((s) => s.ticker)).toEqual(['XLA_US_EQ', 'XLB_US_EQ']);
    });
});

describe('computeMarketSummary — factor leadership (cross-sectional means)', () => {
    it('averages each factor pct + raw across names, ignoring null legs', () => {
        const factorRows = [
            row('A', { momentum: { raw: 1.0, pct: 80 }, value: { raw: 0.0, pct: 50 } }),
            row('B', { momentum: { raw: 2.0, pct: 60 }, value: { raw: null, pct: null } }),
            row('C', { momentum: { raw: 0.0, pct: 40 } }),  // no value leg at all
        ];
        const out = computeMarketSummary(baseInput({ factorRows, factorCycleTs: 1000 }));
        const byFactor = Object.fromEntries(out.factorLeadership.map((f) => [f.factor, f]));

        // momentum: pct mean (80+60+40)/3 = 60; raw mean (1+2+0)/3 = 1
        expect(byFactor.momentum.meanPct).toBeCloseTo(60);
        expect(byFactor.momentum.meanRaw).toBeCloseTo(1);
        expect(byFactor.momentum.count).toBe(3);

        // value: only A has a finite pct (50) — B is null, C absent
        expect(byFactor.value.meanPct).toBeCloseTo(50);
        expect(byFactor.value.meanRaw).toBeCloseTo(0);
        expect(byFactor.value.count).toBe(1);

        // volatility + quality: no legs anywhere → null mean, count 0
        expect(byFactor.volatility.meanPct).toBeNull();
        expect(byFactor.volatility.count).toBe(0);
        expect(byFactor.quality.meanPct).toBeNull();
    });

    it('always returns all four factors in canonical order even with no rows', () => {
        const out = computeMarketSummary(baseInput());
        expect(out.factorLeadership.map((f) => f.factor)).toEqual([...FACTOR_KEYS]);
        for (const f of out.factorLeadership) {
            expect(f.meanPct).toBeNull();
            expect(f.meanRaw).toBeNull();
            expect(f.count).toBe(0);
        }
    });

    it('surfaces the factor cycle knowledge time as asOf', () => {
        const out = computeMarketSummary(baseInput({ factorCycleTs: 1717700000000 }));
        expect(out.asOf).toBe(1717700000000);
    });
});

describe('computeMarketSummary — breadth (% above 200-DMA)', () => {
    it('counts only names with sufficient history in the denominator', () => {
        // 5 names: 3 above, 1 below, 1 insufficient-history (null) → 3/4 = 0.75
        const out = computeMarketSummary(baseInput({
            breadthFlags: [true, true, true, false, null],
        }));
        expect(out.breadth.aboveCount).toBe(3);
        expect(out.breadth.totalWithHistory).toBe(4);
        expect(out.breadth.pctAbove200dma).toBeCloseTo(0.75);
    });

    it('reports null breadth when no name has enough history', () => {
        const out = computeMarketSummary(baseInput({ breadthFlags: [null, null] }));
        expect(out.breadth.pctAbove200dma).toBeNull();
        expect(out.breadth.totalWithHistory).toBe(0);
        expect(out.breadth.aboveCount).toBe(0);
    });

    it('reports full breadth when every name is above', () => {
        const out = computeMarketSummary(baseInput({ breadthFlags: [true, true, true] }));
        expect(out.breadth.pctAbove200dma).toBeCloseTo(1);
    });
});

describe('computeMarketSummary — concentration (HHI vs target)', () => {
    it('computes HHI on normalised weights and compares to 1/topK', () => {
        // Equal-weight 4 names → HHI = 4 * 0.25^2 = 0.25; target = 1/20 = 0.05; excess = 0.20
        const out = computeMarketSummary(baseInput({
            positionWeights: [0.25, 0.25, 0.25, 0.25],
            topK: 20,
        }));
        expect(out.concentration.hhi).toBeCloseTo(0.25);
        expect(out.concentration.targetHhi).toBeCloseTo(0.05);
        expect(out.concentration.excess).toBeCloseTo(0.20);
        expect(out.concentration.positionCount).toBe(4);
    });

    it('normalises a not-fully-invested book before squaring', () => {
        // Gross 0.5 (half in cash) but equal across 2 names → after normalising each is 0.5 → HHI 0.5
        const out = computeMarketSummary(baseInput({ positionWeights: [0.25, 0.25], topK: 2 }));
        expect(out.concentration.hhi).toBeCloseTo(0.5);
        // target = 1/2 = 0.5 → excess ~ 0
        expect(out.concentration.targetHhi).toBeCloseTo(0.5);
        expect(out.concentration.excess).toBeCloseTo(0);
    });

    it('a single fully-concentrated name has HHI 1', () => {
        const out = computeMarketSummary(baseInput({ positionWeights: [1], topK: 20 }));
        expect(out.concentration.hhi).toBeCloseTo(1);
    });

    it('reports null HHI when there are no positions', () => {
        const out = computeMarketSummary(baseInput({ positionWeights: [], topK: 20 }));
        expect(out.concentration.hhi).toBeNull();
        expect(out.concentration.excess).toBeNull();
        expect(out.concentration.positionCount).toBe(0);
    });

    it('reports null target when topK is 0 (no held-set target)', () => {
        const out = computeMarketSummary(baseInput({ positionWeights: [0.5, 0.5], topK: 0 }));
        expect(out.concentration.targetHhi).toBeNull();
        expect(out.concentration.excess).toBeNull();
    });
});

describe('computeMarketSummary — determinism', () => {
    it('is byte-for-byte stable for identical inputs', () => {
        const input = baseInput({
            sectorReturns: [{ sector: 'Tech', ticker: 'XLK_US_EQ', latest: 0.05 }],
            factorRows: [row('A', { momentum: { raw: 1, pct: 70 } })],
            factorCycleTs: 42,
            breadthFlags: [true, false, null],
            positionWeights: [0.6, 0.4],
            topK: 10,
        });
        expect(JSON.stringify(computeMarketSummary(input)))
            .toBe(JSON.stringify(computeMarketSummary(input)));
    });
});
