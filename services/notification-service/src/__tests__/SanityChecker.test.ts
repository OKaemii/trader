// One test per baseline rule. Each test exercises the matching-input case (rule fires)
// and the silent case (rule stays quiet) so a future change to the rule body has a
// chance of being caught by the matching assertion AND the silence assertion.
//
// The shape of the SanityContext is small enough to construct inline — no shared fixture
// machinery needed, and the rules read like a contract: "given X, expect flag Y."

import { describe, it, expect } from 'vitest';
import type { TradeSignalDTO, StrategyOutput } from '@trader/shared-types';
import { SanityChecker } from '../modules/analysis/application/SanityChecker.ts';
import type { TelemetryBlock } from '../modules/analysis/application/ReportContext.ts';

function baseTelemetry(overrides: Partial<TelemetryBlock> = {}): TelemetryBlock {
    return {
        windowStart: 0,
        windowEnd:   0,
        signals: { total: 1, buys: 1, sells: 0, holds: 0, bySector: [] },
        realisedSinceLast: { closedSignals: 0, pnlGbp: 0, bestPick: null, worstPick: null },
        openExposure: {
            navGbp: 10000, cashFractionApprox: 0.5, top3Concentration: 0.3, hhi: 0.1,
            positionsByLifecycle: { pending: 0, approved: 0, queued: 0, executing: 0, executed: 0, closed: 0, failed: 0, cancelled: 0 },
        },
        regime:         { confidence: 0.8, positionSizeMultiplier: 0.85, coldStart: false },
        decay:          { health: 'healthy', multiplier: 1.0, ic_30d: 1.2 },
        universe:       { activeCount: 100, readyCount: 100, unknownSectorFraction: 0.1 },
        circuitBreaker: { open: false, reason: null },
        ...overrides,
    };
}

function makeFeatures(overrides: Partial<StrategyOutput> = {}): StrategyOutput {
    return {
        timestamp:           0,
        strategy_id:         'factor_rank_v1',
        ticker_universe:     [],
        composite_scores:    {},
        factor_attributions: {},
        sectors:             {},
        covariance_matrix:   [],
        regime_confidence:   0.8,
        position_size_multiplier: 0.85,
        ...overrides,
    };
}

const noSignals: TradeSignalDTO[] = [];

describe('SanityChecker — baseline rules', () => {
    describe('CONFIDENCE_SINGLETON_FALLBACK', () => {
        it('fires (critical) on factor_rank with <5 positive composites', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1.0, B: 0.5 } }),
                strategyId: 'factor_rank_v1',
            });
            const f = flags.find((x) => x.code === 'CONFIDENCE_SINGLETON_FALLBACK');
            expect(f?.severity).toBe('critical');
            expect(f?.evidence?.posCount).toBe(2);
        });
        it('fires at warn level for non-factor_rank strategies', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1.0 } }),
                strategyId: 'topology_v1',
            });
            expect(flags.find((x) => x.code === 'CONFIDENCE_SINGLETON_FALLBACK')?.severity).toBe('warn');
        });
        it('silent when posCount >= minPositivePeers', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'CONFIDENCE_SINGLETON_FALLBACK')).toBeUndefined();
        });
    });

    describe('REGIME_COLD_START', () => {
        it('fires when coldStart=true', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ regime: { confidence: 0.5, positionSizeMultiplier: 0.625, coldStart: true } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'REGIME_COLD_START')?.severity).toBe('warn');
        });
        it('silent when regime is warmed', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'REGIME_COLD_START')).toBeUndefined();
        });
    });

    describe('REGIME_MULTIPLIER_MISMATCH', () => {
        it('fires when multiplier drifts from 0.25 + 0.75 * confidence', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                // confidence 0.8 → expected mult ~0.85. Actual 0.30 → drift 0.55.
                telemetry: baseTelemetry({ regime: { confidence: 0.8, positionSizeMultiplier: 0.30, coldStart: false } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            const f = flags.find((x) => x.code === 'REGIME_MULTIPLIER_MISMATCH');
            expect(f?.severity).toBe('critical');
            expect(f?.evidence?.drift as number).toBeGreaterThan(0.05);
        });
        it('silent when multiplier matches the identity within tolerance', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ regime: { confidence: 0.8, positionSizeMultiplier: 0.85, coldStart: false } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'REGIME_MULTIPLIER_MISMATCH')).toBeUndefined();
        });
    });

    describe('UNIVERSE_AT_FLOOR', () => {
        it('fires when readyCount < floor', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ universe: { activeCount: 25, readyCount: 25, unknownSectorFraction: 0 } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'UNIVERSE_AT_FLOOR')?.severity).toBe('warn');
        });
        it('silent when universe is healthy', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'UNIVERSE_AT_FLOOR')).toBeUndefined();
        });
    });

    describe('STABILITY_DEGRADED', () => {
        it('fires when n_unstable > 1', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({
                    composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 },
                    feature_stability: { stability_score: 0.4, n_unstable: 3, features: [] },
                }),
                strategyId: 'factor_rank_v1',
            });
            const f = flags.find((x) => x.code === 'STABILITY_DEGRADED');
            expect(f?.severity).toBe('warn');
            expect(f?.evidence?.n_unstable).toBe(3);
        });
        it('silent when n_unstable <= 1', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({
                    composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 },
                    feature_stability: { stability_score: 0.9, n_unstable: 1, features: [] },
                }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'STABILITY_DEGRADED')).toBeUndefined();
        });
    });

    describe('CIRCUIT_BREAKER_OPEN', () => {
        it('fires (critical) when the breaker is open', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ circuitBreaker: { open: true, reason: 'daily_loss_exceeded' } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            const f = flags.find((x) => x.code === 'CIRCUIT_BREAKER_OPEN');
            expect(f?.severity).toBe('critical');
            expect(f?.message).toContain('daily_loss_exceeded');
        });
        it('silent when breaker is closed', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'CIRCUIT_BREAKER_OPEN')).toBeUndefined();
        });
    });

    describe('DECAY_DEGRADED', () => {
        it('fires (warn) on warning', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ decay: { health: 'warning', multiplier: 0.85, ic_30d: 0.7 } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'DECAY_DEGRADED')?.severity).toBe('warn');
        });
        it('fires (critical) on suspended', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ decay: { health: 'suspended', multiplier: 0, ic_30d: 0 } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'DECAY_DEGRADED')?.severity).toBe('critical');
        });
        it('silent on healthy', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'DECAY_DEGRADED')).toBeUndefined();
        });
    });

    describe('ZERO_BUYS_BUT_ACTIONABLE_THRESHOLD_LOW', () => {
        it('fires only when buys=0 AND the actionable-confidence floor is set very low', () => {
            const flags = new SanityChecker({ minActionableConfidenceFloor: 0.05 }).check({
                signals: noSignals,
                telemetry: baseTelemetry({ signals: { total: 0, buys: 0, sells: 0, holds: 0, bySector: [] } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'ZERO_BUYS_BUT_ACTIONABLE_THRESHOLD_LOW')?.severity).toBe('info');
        });
        it('silent at the default floor (0.1) even with no BUYs', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry({ signals: { total: 0, buys: 0, sells: 0, holds: 0, bySector: [] } }),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'ZERO_BUYS_BUT_ACTIONABLE_THRESHOLD_LOW')).toBeUndefined();
        });
    });

    describe('MISSING_FEATURE_CONTEXT', () => {
        it('fires when the head signal has no features_snapshot', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: undefined,
                strategyId: 'factor_rank_v1',
            });
            const f = flags.find((x) => x.code === 'MISSING_FEATURE_CONTEXT');
            expect(f?.severity).toBe('info');
        });
        it('silent when head features are present', () => {
            const flags = new SanityChecker().check({
                signals: noSignals,
                telemetry: baseTelemetry(),
                headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
                strategyId: 'factor_rank_v1',
            });
            expect(flags.find((x) => x.code === 'MISSING_FEATURE_CONTEXT')).toBeUndefined();
        });
    });

    it('sorts emitted flags by severity (critical → warn → info)', () => {
        const flags = new SanityChecker({ minActionableConfidenceFloor: 0.05 }).check({
            signals: noSignals,
            telemetry: baseTelemetry({
                signals: { total: 0, buys: 0, sells: 0, holds: 0, bySector: [] },     // → info
                regime:  { confidence: 0.5, positionSizeMultiplier: 0.625, coldStart: true },  // → warn
                circuitBreaker: { open: true, reason: 'forced' },                       // → critical
            }),
            headFeatures: makeFeatures({ composite_scores: { A: 1, B: 1, C: 1, D: 1, E: 1 } }),
            strategyId: 'factor_rank_v1',
        });
        const severities = flags.map((f) => f.severity);
        expect(severities).toEqual([...severities].sort((a, b) =>
            ({ critical: 0, warn: 1, info: 2 }[a]) - ({ critical: 0, warn: 1, info: 2 }[b])));
        expect(severities[0]).toBe('critical');
    });
});
