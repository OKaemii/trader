import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';
import { GenericRenderer } from '../../modules/analysis/application/renderers/GenericRenderer.ts';
import type { NarrativeLLM } from '../../modules/analysis/application/renderers/utils.ts';
import type { CycleBatch } from '../../modules/analysis/application/CycleAnalysisBatcher.ts';
import type { TelemetryBlock } from '../../modules/analysis/application/ReportContext.ts';

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    child: () => noopLogger,
} as unknown as Logger;

function batch(overrides: Partial<CycleBatch> = {}): CycleBatch {
    return {
        cycleKey:    'mystery_v1:per_cycle:0',
        strategyId:  'mystery_v1',           // unknown — the fallback path's reason for existing
        cadence:     'per_cycle',
        cycleTs:     1700_000_000_000,
        signals:     [{
            id: 's1', timestamp: 1700_000_000_001, ticker: 'AAPL_US_EQ', strategy_id: 'mystery_v1',
            action: 'BUY', confidence: 0.42, targetWeight: 0.05, rationale: '{}',
        } as TradeSignalDTO],
        firstSeenAt: 1700_000_000_000,
        lastSeenAt:  1700_000_000_000,
        ...overrides,
    };
}

function tel(overrides: Partial<TelemetryBlock> = {}): TelemetryBlock {
    return {
        windowStart: 0, windowEnd: 60_000,
        signals: { total: 1, buys: 1, sells: 0, holds: 0, bySector: [] },
        realisedSinceLast: { closedSignals: 0, pnlGbp: 0, bestPick: null, worstPick: null },
        openExposure: {
            navGbp: 1000, cashFractionApprox: 0.95, top3Concentration: 0.1, hhi: 0.05,
            positionsByLifecycle: { pending: 0, approved: 0, queued: 0, executing: 0, executed: 0, closed: 0, failed: 0, cancelled: 0 },
        },
        regime:         { confidence: 0.7, positionSizeMultiplier: 0.775, coldStart: false },
        decay:          { health: 'healthy', multiplier: 1.0, ic_30d: 0.8 },
        universe:       { activeCount: 100, readyCount: 100, unknownSectorFraction: 0 },
        circuitBreaker: { open: false, reason: null },
        ...overrides,
    };
}

describe('GenericRenderer', () => {
    it('produces a ReportContext with the LLM narrative + empty sectionsHtml', async () => {
        let receivedPrompt = '';
        const llm: NarrativeLLM = {
            async chat(req) {
                receivedPrompt = req.messages[0]!.content;
                return 'A coherent paragraph grounded in the telemetry numbers.';
            },
        };
        const r = new GenericRenderer(llm, noopLogger);
        const ctx = await r.build(batch(), tel(), []);

        expect(ctx.strategyId).toBe('mystery_v1');
        expect(ctx.windowLabel).toMatch(/Cycle —/);
        expect(ctx.narrative).toMatch(/grounded in the telemetry/);
        expect(ctx.sectionsHtml).toBe('');
        // Prompt is locked to "do not invent any number" — important contract for hallucination control.
        expect(receivedPrompt).toContain('Do NOT invent any number');
        expect(receivedPrompt).toContain('TELEMETRY');
        expect(receivedPrompt).toContain('SANITY');
    });

    it('falls back to a templated narrative when the LLM throws', async () => {
        const llm: NarrativeLLM = {
            async chat() { throw new Error('deepseek 502'); },
        };
        const r = new GenericRenderer(llm, noopLogger);
        const ctx = await r.build(batch(), tel(), [
            { severity: 'critical', code: 'CIRCUIT_BREAKER_OPEN', message: 'open' },
        ]);
        // Fallback should still mention the headline numbers — operator gets a coherent email
        // even when the LLM is down.
        expect(ctx.narrative).toContain('1 action');
        expect(ctx.narrative).toContain('CIRCUIT_BREAKER_OPEN');
    });

    it('formats window label for hourly cadence as a time range', async () => {
        const llm: NarrativeLLM = { async chat() { return 'ok'; } };
        const r = new GenericRenderer(llm, noopLogger);
        const ctx = await r.build(
            batch({ cadence: 'hourly', cycleTs: Date.UTC(2026, 4, 18, 14, 0, 0) }),
            tel(), [],
        );
        expect(ctx.windowLabel).toMatch(/Hourly digest 14:00–15:00 UTC/);
    });

    it('formats window label for EOD with market suffix', async () => {
        const llm: NarrativeLLM = { async chat() { return 'ok'; } };
        const r = new GenericRenderer(llm, noopLogger);
        const ctx = await r.build(
            batch({ cadence: 'eod', market: 'US', cycleTs: Date.UTC(2026, 4, 18) }),
            tel(), [],
        );
        expect(ctx.windowLabel).toMatch(/EOD US — 2026-05-18/);
    });
});
