import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import type { StrategyOutput, TradeSignalDTO } from '@trader/shared-types';
import { FactorRankRenderer } from '../../modules/analysis/application/renderers/FactorRankRenderer.ts';
import type { NarrativeLLM } from '../../modules/analysis/application/renderers/utils.ts';
import type { CycleBatch } from '../../modules/analysis/application/CycleAnalysisBatcher.ts';
import type { TelemetryBlock } from '../../modules/analysis/application/ReportContext.ts';

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    child: () => noopLogger,
} as unknown as Logger;

const stubLLM: NarrativeLLM = { async chat() { return 'stub-narrative'; } };

function makeFeatures(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
        timestamp: 0, strategy_id: 'factor_rank_v1',
        ticker_universe: ['AAPL_US_EQ', 'MSFT_US_EQ', 'GOOG_US_EQ'],
        composite_scores: { AAPL_US_EQ: 1.5, MSFT_US_EQ: 0.8, GOOG_US_EQ: -0.4 },
        factor_attributions: {
            AAPL_US_EQ: { momentum: 0.7, reversal: -0.1, low_vol: 0.3 },
            MSFT_US_EQ: { momentum: 0.5, reversal: 0.1,  low_vol: 0.2 },
            GOOG_US_EQ: { momentum: 0.4, reversal: -0.3, low_vol: 0.1 },
        },
        sectors: { AAPL_US_EQ: 'Tech', MSFT_US_EQ: 'Tech', GOOG_US_EQ: 'Tech' },
        covariance_matrix: [],
        regime_confidence: 0.7,
        position_size_multiplier: 0.775,
        feature_stability: {
            stability_score: 0.85, n_unstable: 1,
            features: [
                { name: 'momentum', cv: 0.2, is_stationary: true  },
                { name: 'reversal', cv: 1.3, is_stationary: false },
                { name: 'low_vol',  cv: 0.4, is_stationary: true  },
            ],
        },
        ...overrides,
    };
}

function batch(features: StrategyOutput | undefined, overrides: Partial<CycleBatch> = {}): CycleBatch {
    const signal = (ticker: string): TradeSignalDTO => ({
        id: `s-${ticker}`, timestamp: 1700_000_000_000, ticker,
        strategy_id: 'factor_rank_v1', action: 'BUY', confidence: 0.5,
        targetWeight: 0.05, rationale: '{}',
        features_snapshot: features,
    } as TradeSignalDTO);
    return {
        cycleKey: 'factor_rank_v1:per_cycle:0',
        strategyId: 'factor_rank_v1',
        cadence: 'per_cycle',
        cycleTs: 1700_000_000_000,
        signals: [signal('AAPL_US_EQ'), signal('MSFT_US_EQ')],
        firstSeenAt: 1700_000_000_000,
        lastSeenAt:  1700_000_000_000,
        ...overrides,
    };
}

function tel(): TelemetryBlock {
    return {
        windowStart: 0, windowEnd: 60_000,
        signals: { total: 2, buys: 2, sells: 0, holds: 0, bySector: [] },
        realisedSinceLast: { closedSignals: 0, pnlGbp: 0, bestPick: null, worstPick: null },
        openExposure: {
            navGbp: 1000, cashFractionApprox: 0.9, top3Concentration: 0.1, hhi: 0.05,
            positionsByLifecycle: { pending: 0, approved: 0, queued: 0, executing: 0, executed: 0, closed: 0, failed: 0, cancelled: 0 },
        },
        regime: { confidence: 0.7, positionSizeMultiplier: 0.775, coldStart: false },
        decay:  { health: 'healthy', multiplier: 1.0, ic_30d: 0.8 },
        universe: { activeCount: 100, readyCount: 100, unknownSectorFraction: 0 },
        circuitBreaker: { open: false, reason: null },
        history: { previousDigestAt: null, timeSinceLastDigestMs: null, signalsSinceLastDigest: 0, priorAppearances: {} },
    };
}

describe('FactorRankRenderer', () => {
    it('produces sectionsHtml containing the factor dominance table + dispersion + stability', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const ctx = await r.build(batch(makeFeatures()), tel(), []);
        expect(ctx.sectionsHtml).toContain('Factor dominance per pick');
        expect(ctx.sectionsHtml).toContain('Cross-sectional dispersion');
        expect(ctx.sectionsHtml).toContain('Feature stability');
        // Composite values surface per-ticker
        expect(ctx.sectionsHtml).toContain('1.500');
        expect(ctx.sectionsHtml).toContain('0.800');
    });

    it('emits FACTOR_DEGENERATE when composite stddev is below the floor', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const features = makeFeatures({
            composite_scores: { A: 0.5, B: 0.500001, C: 0.500002, D: 0.500003 },
        });
        const flags = r.strategyRules(features);
        const flag = flags.find((f) => f.code === 'FACTOR_DEGENERATE');
        expect(flag?.severity).toBe('critical');
    });

    it('stays silent on FACTOR_DEGENERATE when scores are dispersed', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const flags = r.strategyRules(makeFeatures());
        expect(flags.find((f) => f.code === 'FACTOR_DEGENERATE')).toBeUndefined();
    });

    it('emits FACTOR_DOMINANCE_SHIFT (info) when one factor wins >80% of picks', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const features = makeFeatures({
            factor_attributions: {
                A: { momentum: 1.0, reversal: 0.0, low_vol: 0.0 },
                B: { momentum: 1.0, reversal: 0.0, low_vol: 0.0 },
                C: { momentum: 1.0, reversal: 0.0, low_vol: 0.0 },
                D: { momentum: 1.0, reversal: 0.0, low_vol: 0.0 },
                E: { momentum: 1.0, reversal: 0.0, low_vol: 0.0 },
            },
        });
        const flag = r.strategyRules(features).find((f) => f.code === 'FACTOR_DOMINANCE_SHIFT');
        expect(flag?.severity).toBe('info');
        expect((flag?.evidence as { factor: string }).factor).toBe('momentum');
    });

    it('gracefully degrades when features_snapshot is missing', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const ctx = await r.build(batch(undefined), tel(), []);
        expect(ctx.sectionsHtml).toContain('No features_snapshot');
        expect(ctx.sanity.find((f) => f.code === 'FACTOR_DEGENERATE')).toBeUndefined();
    });

    // Regression test for the per-signal-slice bug. signal-service emits each TradeSignal
    // with a features_snapshot containing ONLY that signal's own ticker in
    // composite_scores/factor_attributions/sectors (and an empty ticker_universe). The
    // renderer previously read only batch.signals[0].features_snapshot, so the factor
    // table showed values for the head pick and "—" for every other pick. The merge
    // helper unions the per-ticker maps across all signals so each pick's row resolves.
    it('renders per-pick factor values when each signal carries only its own slice', async () => {
        const r = new FactorRankRenderer(stubLLM, noopLogger);
        const sliceFor = (ticker: string, score: number, attr: Record<string, number>): StrategyOutput => ({
            timestamp: 0, strategy_id: 'factor_rank_v1',
            ticker_universe: [],
            composite_scores: { [ticker]: score },
            factor_attributions: { [ticker]: attr },
            sectors: { [ticker]: 'Unknown' },
            covariance_matrix: [],
            regime_confidence: 0.7,
            position_size_multiplier: 0.775,
        });
        const sig = (ticker: string, snapshot: StrategyOutput): TradeSignalDTO => ({
            id: `s-${ticker}`, timestamp: 1700_000_000_000, ticker,
            strategy_id: 'factor_rank_v1', action: 'SELL', confidence: 0.4,
            targetWeight: 0.0, rationale: '{}',
            features_snapshot: snapshot,
        } as TradeSignalDTO);
        const perSignalBatch: CycleBatch = {
            cycleKey: 'factor_rank_v1:per_cycle:0',
            strategyId: 'factor_rank_v1',
            cadence: 'per_cycle',
            cycleTs: 1700_000_000_000,
            signals: [
                sig('BKGl_EQ',  sliceFor('BKGl_EQ',  -0.395, { momentum: -0.594, reversal: -0.503, low_vol: -0.086 })),
                sig('CCHl_EQ',  sliceFor('CCHl_EQ',   0.343, { momentum:  0.421, reversal:  0.122, low_vol:  0.085 })),
                sig('BRBYl_EQ', sliceFor('BRBYl_EQ',  0.667, { momentum:  0.812, reversal:  0.205, low_vol:  0.150 })),
            ],
            firstSeenAt: 1700_000_000_000,
            lastSeenAt:  1700_000_000_000,
        };
        const ctx = await r.build(perSignalBatch, tel(), []);
        // Every pick's composite renders, not just the head's.
        expect(ctx.sectionsHtml).toContain('-0.395');
        expect(ctx.sectionsHtml).toContain('0.343');
        expect(ctx.sectionsHtml).toContain('0.667');
        // Dispersion histogram is computed across all picks (n=3), not the head only (n=1).
        expect(ctx.sectionsHtml).toMatch(/n=3/);
    });
});
