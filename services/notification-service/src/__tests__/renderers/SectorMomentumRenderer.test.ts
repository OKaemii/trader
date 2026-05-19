import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import type { StrategyOutput, TradeSignalDTO } from '@trader/shared-types';
import { SectorMomentumRenderer } from '../../modules/analysis/application/renderers/SectorMomentumRenderer.ts';
import type { NarrativeLLM } from '../../modules/analysis/application/renderers/utils.ts';
import type { CycleBatch } from '../../modules/analysis/application/CycleAnalysisBatcher.ts';
import type { TelemetryBlock } from '../../modules/analysis/application/ReportContext.ts';

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    child: () => noopLogger,
} as unknown as Logger;

const stubLLM: NarrativeLLM = { async chat() { return 'stub'; } };

function healthyFeatures(): StrategyOutput {
    return {
        timestamp: 0, strategy_id: 'sector_momentum_v1',
        ticker_universe: ['AAPL_US_EQ', 'MSFT_US_EQ', 'XOM_US_EQ', 'CVX_US_EQ'],
        composite_scores: { AAPL_US_EQ: 1.0, MSFT_US_EQ: 0.5, XOM_US_EQ: -0.5, CVX_US_EQ: -1.0 },
        factor_attributions: {
            AAPL_US_EQ: { sector_momentum: 1.0, momentum: 0.3, topology: 0, residual_alpha: 1.0, degraded_unknown_sectors: 0 },
            MSFT_US_EQ: { sector_momentum: 0.5, momentum: 0.1, topology: 0, residual_alpha: 0.5, degraded_unknown_sectors: 0 },
            XOM_US_EQ:  { sector_momentum: -0.5, momentum: 0.05, topology: 0, residual_alpha: -0.5, degraded_unknown_sectors: 0 },
            CVX_US_EQ:  { sector_momentum: -1.0, momentum: 0.02, topology: 0, residual_alpha: -1.0, degraded_unknown_sectors: 0 },
        },
        sectors: { AAPL_US_EQ: 'Tech', MSFT_US_EQ: 'Tech', XOM_US_EQ: 'Energy', CVX_US_EQ: 'Energy' },
        covariance_matrix: [],
        regime_confidence: 0.7,
        position_size_multiplier: 0.775,
    };
}

function batch(features: StrategyOutput | undefined, picks: Array<{ticker: string}>): CycleBatch {
    const signals: TradeSignalDTO[] = picks.map((p) => ({
        id: `s-${p.ticker}`, timestamp: 1700_000_000_000, ticker: p.ticker,
        strategy_id: 'sector_momentum_v1', action: 'BUY', confidence: 0.5,
        targetWeight: 0.1, rationale: '{}', features_snapshot: features,
    } as TradeSignalDTO));
    return {
        cycleKey: 'sector_momentum_v1:per_cycle:0',
        strategyId: 'sector_momentum_v1', cadence: 'per_cycle',
        cycleTs: 1700_000_000_000,
        signals,
        firstSeenAt: 0, lastSeenAt: 0,
    };
}

function tel(unknownFraction = 0.0): TelemetryBlock {
    return {
        windowStart: 0, windowEnd: 0,
        signals: { total: 0, buys: 0, sells: 0, holds: 0, bySector: [] },
        realisedSinceLast: { closedSignals: 0, pnlGbp: 0, bestPick: null, worstPick: null },
        openExposure: {
            navGbp: 1000, cashFractionApprox: 0.9, top3Concentration: 0.1, hhi: 0.05,
            positionsByLifecycle: { pending: 0, approved: 0, queued: 0, executing: 0, executed: 0, closed: 0, failed: 0, cancelled: 0 },
        },
        regime: { confidence: 0.7, positionSizeMultiplier: 0.775, coldStart: false },
        decay: { health: 'healthy', multiplier: 1.0, ic_30d: 0.8 },
        universe: { activeCount: 100, readyCount: 100, unknownSectorFraction: unknownFraction },
        circuitBreaker: { open: false, reason: null },
    };
}

describe('SectorMomentumRenderer', () => {
    it('renders sector means table + per-pick adjusted table', async () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const ctx = await r.build(
            batch(healthyFeatures(), [{ ticker: 'AAPL_US_EQ' }, { ticker: 'XOM_US_EQ' }]),
            tel(), [],
        );
        expect(ctx.sectionsHtml).toContain('Sector means');
        expect(ctx.sectionsHtml).toContain('Per-pick: raw vs sector-adjusted');
        expect(ctx.sectionsHtml).toContain('Tech');
        expect(ctx.sectionsHtml).toContain('Energy');
    });

    it('emits SECTOR_DATA_MISSING (critical) when unknown-fraction > 50%', () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const features = healthyFeatures();
        features.sectors = {
            AAPL_US_EQ: 'Tech', MSFT_US_EQ: 'Unknown', XOM_US_EQ: 'Unknown', CVX_US_EQ: 'Unknown',
        };
        const flags = r.strategyRules(features, batch(features, [{ ticker: 'AAPL_US_EQ' }]));
        expect(flags.find((f) => f.code === 'SECTOR_DATA_MISSING')?.severity).toBe('critical');
    });

    it('emits SECTOR_DATA_MISSING from the strategy-stamped degraded flag even if sectors map is fine', () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const features = healthyFeatures();
        // Strategy claims 70% unknown via the per-ticker stamp even though sectors look populated.
        // We trust the strategy's view over our recomputation since the strategy saw the source data.
        for (const row of Object.values(features.factor_attributions)) {
            (row as Record<string, number>).degraded_unknown_sectors = 0.7;
        }
        const flags = r.strategyRules(features, batch(features, [{ ticker: 'AAPL_US_EQ' }]));
        expect(flags.find((f) => f.code === 'SECTOR_DATA_MISSING')?.severity).toBe('critical');
    });

    it('emits SECTOR_CONCENTRATION_OVERFLOW (warn) when one sector > 50% of picks', () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const features = healthyFeatures();
        const b = batch(features, [
            { ticker: 'AAPL_US_EQ' }, { ticker: 'MSFT_US_EQ' }, { ticker: 'XOM_US_EQ' },
        ]);  // 2/3 Tech
        const flags = r.strategyRules(features, b);
        const flag = flags.find((f) => f.code === 'SECTOR_CONCENTRATION_OVERFLOW');
        expect(flag?.severity).toBe('warn');
        expect((flag?.evidence as { sector: string }).sector).toBe('Tech');
    });

    it('stays silent on both rules in the healthy diversified case', () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const features = healthyFeatures();
        const b = batch(features, [{ ticker: 'AAPL_US_EQ' }, { ticker: 'XOM_US_EQ' }]);  // 1 Tech + 1 Energy
        const flags = r.strategyRules(features, b);
        expect(flags.find((f) => f.code === 'SECTOR_DATA_MISSING')).toBeUndefined();
        expect(flags.find((f) => f.code === 'SECTOR_CONCENTRATION_OVERFLOW')).toBeUndefined();
    });

    it('renders the sector-coverage banner when unknownFraction > 30%', async () => {
        const r = new SectorMomentumRenderer(stubLLM, noopLogger);
        const ctx = await r.build(
            batch(healthyFeatures(), [{ ticker: 'AAPL_US_EQ' }]),
            tel(0.4), [],
        );
        expect(ctx.sectionsHtml).toContain('Sector coverage degraded');
    });
});
