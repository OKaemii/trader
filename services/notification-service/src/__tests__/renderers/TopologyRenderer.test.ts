import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import type { StrategyOutput, TradeSignalDTO } from '@trader/shared-types';
import { TopologyRenderer } from '../../modules/analysis/application/renderers/TopologyRenderer.ts';
import type { NarrativeLLM } from '../../modules/analysis/application/renderers/utils.ts';
import type { CycleBatch } from '../../modules/analysis/application/CycleAnalysisBatcher.ts';
import type { TelemetryBlock } from '../../modules/analysis/application/ReportContext.ts';

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    child: () => noopLogger,
} as unknown as Logger;

const stubLLM: NarrativeLLM = { async chat() { return 'stub'; } };

function makeFeatures(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
        timestamp: 0, strategy_id: 'topology_v1',
        ticker_universe: ['AAPL_US_EQ', 'MSFT_US_EQ'],
        composite_scores: { AAPL_US_EQ: 0.5, MSFT_US_EQ: 0.3 },
        factor_attributions: { AAPL_US_EQ: {}, MSFT_US_EQ: {} },
        sectors: { AAPL_US_EQ: 'Tech', MSFT_US_EQ: 'Tech' },
        covariance_matrix: [],
        regime_confidence: 0.7,
        position_size_multiplier: 0.775,
        signal_weights: { topology: 0.3, factor: 0.7 },
        betti_curves: {
            epsilon_range: [0.0, 0.1, 0.2, 0.3, 0.4],
            beta0: [10, 8, 5, 3, 1],
            beta1: [0, 2, 4, 3, 1],
        },
        persistence_pairs: [
            [0.05, 0.30, 1],
            [0.10, 0.15, 0],
            [0.12, 0.40, 1],
        ],
        laplacian_residuals: { AAPL_US_EQ: 0.42, MSFT_US_EQ: -0.21 },
        ...overrides,
    };
}

function batch(features: StrategyOutput | undefined): CycleBatch {
    const sig = (t: string): TradeSignalDTO => ({
        id: `s-${t}`, timestamp: 1700_000_000_000, ticker: t, strategy_id: 'topology_v1',
        action: 'BUY', confidence: 0.5, targetWeight: 0.05, rationale: '{}',
        features_snapshot: features,
    } as TradeSignalDTO);
    return {
        cycleKey: 'topology_v1:per_cycle:0', strategyId: 'topology_v1', cadence: 'per_cycle',
        cycleTs: 1700_000_000_000, firstSeenAt: 0, lastSeenAt: 0,
        signals: [sig('AAPL_US_EQ'), sig('MSFT_US_EQ')],
    };
}

function tel(): TelemetryBlock {
    return {
        windowStart: 0, windowEnd: 0,
        signals: { total: 2, buys: 2, sells: 0, holds: 0, bySector: [] },
        realisedSinceLast: { closedSignals: 0, pnlGbp: 0, bestPick: null, worstPick: null },
        openExposure: {
            navGbp: 1000, cashFractionApprox: 0.9, top3Concentration: 0.1, hhi: 0.05,
            positionsByLifecycle: { pending: 0, approved: 0, queued: 0, executing: 0, executed: 0, closed: 0, failed: 0, cancelled: 0 },
        },
        regime: { confidence: 0.7, positionSizeMultiplier: 0.775, coldStart: false },
        decay: { health: 'healthy', multiplier: 1.0, ic_30d: 0.8 },
        universe: { activeCount: 100, readyCount: 100, unknownSectorFraction: 0 },
        circuitBreaker: { open: false, reason: null },
    };
}

describe('TopologyRenderer', () => {
    it('renders betti sparkline + persistence pairs + laplacian residuals', async () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const ctx = await r.build(batch(makeFeatures()), tel(), []);
        expect(ctx.sectionsHtml).toContain('β₁ across filtration');
        expect(ctx.sectionsHtml).toContain('Top persistence pairs');
        expect(ctx.sectionsHtml).toContain('Per-pick Laplacian residual');
        // Top persistence pair by lifetime is (0.12, 0.40, 1) with lifetime 0.28
        expect(ctx.sectionsHtml).toContain('0.280');
    });

    it('emits TOPOLOGY_GATED when topology weight falls below the floor', () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const flags = r.strategyRules(makeFeatures({ signal_weights: { topology: 0.02, factor: 0.98 } }));
        expect(flags.find((f) => f.code === 'TOPOLOGY_GATED')?.severity).toBe('info');
    });

    it('emits BETTI_EMPTY when max(β₁) === 0', () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const flags = r.strategyRules(makeFeatures({
            betti_curves: { epsilon_range: [0, 0.1, 0.2], beta0: [5, 4, 3], beta1: [0, 0, 0] },
        }));
        expect(flags.find((f) => f.code === 'BETTI_EMPTY')?.severity).toBe('warn');
    });

    it('emits LAPLACIAN_RESIDUALS_DEGENERATE when every residual is 0', () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const flags = r.strategyRules(makeFeatures({ laplacian_residuals: { A: 0, B: 0, C: 0 } }));
        expect(flags.find((f) => f.code === 'LAPLACIAN_RESIDUALS_DEGENERATE')?.severity).toBe('critical');
    });

    it('stays silent on all topology rules in the healthy case', () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const flags = r.strategyRules(makeFeatures());
        expect(flags.find((f) => f.code === 'TOPOLOGY_GATED')).toBeUndefined();
        expect(flags.find((f) => f.code === 'BETTI_EMPTY')).toBeUndefined();
        expect(flags.find((f) => f.code === 'LAPLACIAN_RESIDUALS_DEGENERATE')).toBeUndefined();
    });

    it('gracefully degrades when features_snapshot is missing', async () => {
        const r = new TopologyRenderer(stubLLM, noopLogger);
        const ctx = await r.build(batch(undefined), tel(), []);
        expect(ctx.sectionsHtml).toContain('No features_snapshot');
    });
});
