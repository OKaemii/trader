// Unit tests for TelemetryBuilder. Stubs both upstream HTTP clients so we don't carry
// a real signal-service or market-data-service into the test loop. Focus: the local
// computations (by-action split, HHI, top-3, sector roll-up) and the merge of the
// remote snapshots with the head signal's features_snapshot.

import { describe, it, expect, vi } from 'vitest';
import type { TradeSignalDTO, StrategyOutput } from '@trader/shared-types';
import type { TelemetrySnapshotResponse } from '@trader/contracts';
import { TelemetryBuilder, type ISignalTelemetryFetcher, type ISectorsFetcher } from '../modules/analysis/application/TelemetryBuilder.ts';
import type { CycleBatch } from '../modules/analysis/application/CycleAnalysisBatcher.ts';

const noopLogger: any = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeFeatures(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
        timestamp:           1700000000000,
        strategy_id:         'factor_rank_v1',
        ticker_universe:     [],
        composite_scores:    {},
        factor_attributions: {},
        sectors:             {},
        covariance_matrix:   [],
        regime_confidence:   0.7,
        position_size_multiplier: 0.8,
        ...overrides,
    };
}

function makeSignal(args: Partial<TradeSignalDTO> & { ticker: string; targetWeight: number; confidence: number; action: 'BUY' | 'SELL' | 'HOLD' }): TradeSignalDTO {
    return {
        id: `sig-${args.ticker}`,
        timestamp: 1700000000000,
        ticker: args.ticker,
        strategy_id: 'factor_rank_v1',
        action: args.action,
        confidence: args.confidence,
        targetWeight: args.targetWeight,
        rationale: '{}',
        ...args,
    };
}

function makeBatch(signals: TradeSignalDTO[]): CycleBatch {
    return {
        cycleKey:    'factor_rank_v1:per_cycle:0',
        strategyId:  'factor_rank_v1',
        cadence:     'per_cycle',
        cycleTs:     1700000000000,
        signals,
        firstSeenAt: 1700000000000,
        lastSeenAt:  1700000060000,
    };
}

const snapshot: TelemetrySnapshotResponse = {
    since: 0,
    computedAt: 1700000060000,
    realisedSinceLast: {
        closedSignals: 1,
        pnlGbp: 250,
        bestPick:  { ticker: 'AAPL_US_EQ', pnlPct: 0.05, pnlGbp: 250 },
        worstPick: { ticker: 'AAPL_US_EQ', pnlPct: 0.05, pnlGbp: 250 },
    },
    lifecycleCounters: {
        pending: 1, approved: 2, queued: 3, executing: 0,
        executed: 5, closed: 7, failed: 1, cancelled: 0,
    },
    openPositions: { count: 4, mtmGbp: 8000, fxDegraded: false },
    risk: {
        navGbp: 10000, hwmGbp: 11000, dailyLossPct: 0.01, drawdownPct: 0.09,
        circuit: { open: false, reason: null },
    },
    decay: {
        health: 'warning',
        metrics: {
            rollingSharpe30d: 0.7, hitRate30d: 0.5, turnoverRatio: 1.2,
            icTStat: 1.0, featureDriftKL: 0.3, computedAt: 1700000000000,
        },
    },
};

const sectorsResp = {
    sectors: {
        AAPL_US_EQ: 'Technology',
        MSFT_US_EQ: 'Technology',
        JPM_US_EQ:  'Financials',
        XYZ_US_EQ:  'Unknown',
    },
    fetchedAt: 1700000000000,
};

function stubFetchers(): { signals: ISignalTelemetryFetcher; universe: ISectorsFetcher } {
    return {
        signals:  { telemetrySnapshot: async () => snapshot },
        universe: { fetchSectors:      async () => sectorsResp },
    };
}

describe('TelemetryBuilder', () => {
    it('counts BUY/SELL/HOLD locally', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const batch = makeBatch([
            makeSignal({ ticker: 'AAPL_US_EQ', action: 'BUY',  targetWeight: 0.05, confidence: 0.7 }),
            makeSignal({ ticker: 'MSFT_US_EQ', action: 'BUY',  targetWeight: 0.03, confidence: 0.6 }),
            makeSignal({ ticker: 'JPM_US_EQ',  action: 'SELL', targetWeight: 0.02, confidence: 0.5 }),
        ]);
        const t = await tb.build(batch);
        expect(t.signals.total).toBe(3);
        expect(t.signals.buys).toBe(2);
        expect(t.signals.sells).toBe(1);
        expect(t.signals.holds).toBe(0);
    });

    it('rolls up by sector using features_snapshot.sectors', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const features = makeFeatures({
            sectors:          { AAPL_US_EQ: 'Technology', MSFT_US_EQ: 'Technology', JPM_US_EQ: 'Financials' },
            composite_scores: { AAPL_US_EQ: 1.0, MSFT_US_EQ: 0.5, JPM_US_EQ: -0.5 },
        });
        const batch = makeBatch([
            makeSignal({ ticker: 'AAPL_US_EQ', action: 'BUY', targetWeight: 0.05, confidence: 0.7, features_snapshot: features }),
            makeSignal({ ticker: 'MSFT_US_EQ', action: 'BUY', targetWeight: 0.03, confidence: 0.6, features_snapshot: features }),
            makeSignal({ ticker: 'JPM_US_EQ',  action: 'SELL', targetWeight: 0.02, confidence: 0.5, features_snapshot: features }),
        ]);
        const t = await tb.build(batch);
        expect(t.signals.bySector.length).toBe(2);
        const tech = t.signals.bySector.find((s) => s.sector === 'Technology')!;
        expect(tech.n).toBe(2);
        expect(tech.avgConfidence).toBeCloseTo(0.65);
        expect(tech.avgScore).toBeCloseTo(0.75);
    });

    it('treats missing sector as Unknown', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const batch = makeBatch([makeSignal({ ticker: 'AAPL_US_EQ', action: 'BUY', targetWeight: 0.05, confidence: 0.5 })]);
        const t = await tb.build(batch);
        expect(t.signals.bySector[0]?.sector).toBe('Unknown');
    });

    it('computes top-3 concentration and HHI on normalised weights', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const batch = makeBatch([
            makeSignal({ ticker: 'A', action: 'BUY', targetWeight: 0.5,  confidence: 0.5 }),
            makeSignal({ ticker: 'B', action: 'BUY', targetWeight: 0.25, confidence: 0.5 }),
            makeSignal({ ticker: 'C', action: 'BUY', targetWeight: 0.125, confidence: 0.5 }),
            makeSignal({ ticker: 'D', action: 'BUY', targetWeight: 0.125, confidence: 0.5 }),
        ]);
        const t = await tb.build(batch);
        // normalised weights: 0.5, 0.25, 0.125, 0.125 → top3 = 0.875
        expect(t.openExposure.top3Concentration).toBeCloseTo(0.875);
        // HHI = 0.5^2 + 0.25^2 + 0.125^2 + 0.125^2 = 0.34375
        expect(t.openExposure.hhi).toBeCloseTo(0.34375);
    });

    it('merges remote snapshot fields verbatim', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const t = await tb.build(makeBatch([]));
        expect(t.realisedSinceLast.closedSignals).toBe(1);
        expect(t.realisedSinceLast.pnlGbp).toBe(250);
        expect(t.realisedSinceLast.bestPick?.ticker).toBe('AAPL_US_EQ');
        expect(t.openExposure.navGbp).toBe(10000);
        expect(t.openExposure.positionsByLifecycle.executed).toBe(5);
        expect(t.decay.health).toBe('warning');
        expect(t.decay.multiplier).toBeCloseTo(0.85);
        expect(t.decay.ic_30d).toBeCloseTo(1.0);
        expect(t.circuitBreaker.open).toBe(false);
    });

    it('reads regime + cold-start from head signal', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const features = makeFeatures({ regime_confidence: 0.5, position_size_multiplier: 0.625 });
        const batch = makeBatch([makeSignal({ ticker: 'A', action: 'BUY', targetWeight: 0.05, confidence: 0.5, features_snapshot: features })]);
        const t = await tb.build(batch);
        expect(t.regime.confidence).toBe(0.5);
        expect(t.regime.positionSizeMultiplier).toBe(0.625);
        expect(t.regime.coldStart).toBe(true);
    });

    it('computes universe coverage + unknown-sector fraction from the sectors map', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const t = await tb.build(makeBatch([]));
        expect(t.universe.activeCount).toBe(4);
        // 1 Unknown out of 4
        expect(t.universe.unknownSectorFraction).toBeCloseTo(0.25);
    });

    it('approximates cash fraction from NAV vs open MTM', async () => {
        const fx = stubFetchers();
        const tb = new TelemetryBuilder(fx.signals, fx.universe, noopLogger);
        const t = await tb.build(makeBatch([]));
        // 1 - 8000/10000 = 0.2
        expect(t.openExposure.cashFractionApprox).toBeCloseTo(0.2);
    });

    it('degrades gracefully when telemetry-snapshot fetch fails', async () => {
        const fetchers: { signals: ISignalTelemetryFetcher; universe: ISectorsFetcher } = {
            signals:  { telemetrySnapshot: async () => { throw new Error('boom'); } },
            universe: { fetchSectors:      async () => sectorsResp },
        };
        const tb = new TelemetryBuilder(fetchers.signals, fetchers.universe, noopLogger);
        const t = await tb.build(makeBatch([]));
        expect(t.realisedSinceLast.closedSignals).toBe(0);
        expect(t.openExposure.navGbp).toBe(0);
        expect(t.openExposure.cashFractionApprox).toBeNull();
        expect(t.decay.health).toBe('healthy');   // default
        expect(t.circuitBreaker.open).toBe(false);
    });

    it('passes batch.cycleTs as `since` to the snapshot fetcher', async () => {
        const fetcher = { telemetrySnapshot: vi.fn(async () => snapshot) };
        const tb = new TelemetryBuilder(fetcher, { fetchSectors: async () => sectorsResp }, noopLogger);
        await tb.build(makeBatch([]));
        expect(fetcher.telemetrySnapshot).toHaveBeenCalledWith(1700000000000);
    });
});
