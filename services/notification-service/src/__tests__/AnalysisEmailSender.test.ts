// End-to-end test for the orchestrated AnalysisEmailSender. The class fans out across
// TelemetryBuilder → SanityChecker → renderer.build → renderHtml → transport.send, and
// the renderer dispatch (by strategy_id) is the seam that decides which strategy-specific
// section appears in the email. The test exercises a representative factor_rank batch
// and confirms (a) telemetry numbers surface, (b) at least one sanity flag is rendered,
// (c) the FactorRank-specific section landed in the HTML, (d) the LLM narrative is
// included, (e) the transport receives the expected subject + html.

import { describe, it, expect } from 'vitest';
import type { Logger } from '@trader/core';
import type { StrategyOutput, TradeSignalDTO } from '@trader/shared-types';
import {
    AnalysisEmailSender, type AnalysisEmailTransport,
} from '../modules/analysis/infrastructure/AnalysisEmailSender.ts';
import { TelemetryBuilder, type ISectorsFetcher, type ISignalTelemetryFetcher } from '../modules/analysis/application/TelemetryBuilder.ts';
import { SanityChecker } from '../modules/analysis/application/SanityChecker.ts';
import { FactorRankRenderer } from '../modules/analysis/application/renderers/FactorRankRenderer.ts';
import { GenericRenderer } from '../modules/analysis/application/renderers/GenericRenderer.ts';
import type { NarrativeLLM } from '../modules/analysis/application/renderers/utils.ts';
import type { StrategyRenderer } from '../modules/analysis/application/ReportContext.ts';
import type { CycleBatch } from '../modules/analysis/application/CycleAnalysisBatcher.ts';
import type { CompanyProfileService } from '../modules/analysis/application/CompanyProfileService.ts';

const noopLogger: Logger = {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
    child: () => noopLogger,
} as unknown as Logger;

function makeFeatures(): StrategyOutput {
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
        regime_confidence: 0.5,                  // 0.5 sentinel → REGIME_COLD_START fires
        position_size_multiplier: 0.625,         // 0.25 + 0.75*0.5 — keeps multiplier rule silent
        feature_stability: {
            stability_score: 0.85, n_unstable: 0,
            features: [{ name: 'momentum', cv: 0.2, is_stationary: true }],
        },
    };
}

function makeBatch(): CycleBatch {
    const f = makeFeatures();
    const sig = (ticker: string): TradeSignalDTO => ({
        id: `s-${ticker}`, timestamp: 1700_000_000_000, ticker,
        strategy_id: 'factor_rank_v1', action: 'BUY',
        confidence: 0.42, targetWeight: 0.05,
        rationale: JSON.stringify({ plain_english: 'reason', economic_mechanism: 'momentum', uncertainty: 'low' }),
        features_snapshot: f,
        entryPrice: 100,
    } as TradeSignalDTO);
    return {
        cycleKey: 'factor_rank_v1:per_cycle:0',
        strategyId: 'factor_rank_v1',
        cadence: 'per_cycle',
        cycleTs: 1700_000_000_000,
        signals: [sig('AAPL_US_EQ'), sig('MSFT_US_EQ')],
        firstSeenAt: 0, lastSeenAt: 0,
    };
}

// Stub collaborators so the test exercises the orchestration end-to-end without network.
const signalFetcher: ISignalTelemetryFetcher = {
    async telemetrySnapshot() {
        return {
            since: 0,
            realisedSinceLast: { closedSignals: 2, pnlGbp: 12.5, bestPick: { ticker: 'AAPL_US_EQ', pnlPct: 0.05, pnlGbp: 8 }, worstPick: null },
            openPositions: { mtmGbp: 200, count: 3 },
            lifecycleCounters: { pending: 0, approved: 0, queued: 1, executing: 0, executed: 2, closed: 0, failed: 0, cancelled: 0 },
            risk: { navGbp: 1000, circuit: { open: false, reason: null } },
            decay: { health: 'healthy', metrics: { icTStat: 1.2 } as never },
        } as never;
    },
};
const sectorsFetcher: ISectorsFetcher = {
    async fetchSectors() {
        return {
            sectors: {
                AAPL_US_EQ: 'Tech', MSFT_US_EQ: 'Tech', GOOG_US_EQ: 'Tech',
                XOM_US_EQ: 'Energy', JPM_US_EQ: 'Financial', UNH_US_EQ: 'Health',
            },
            fetchedAt: Date.now(),
        };
    },
};
const profiles = {
    async get() {
        return { name: 'Apple Inc.', history: 'h', market_position: 'm', differentiator: 'd' };
    },
} as unknown as CompanyProfileService;

const llm: NarrativeLLM = {
    async chat() { return 'The factor mix is momentum-dominated; cold-start regime caps sizing.'; },
};

describe('AnalysisEmailSender (orchestrated)', () => {
    it('builds telemetry → sanity → renderer → html and ships it via the transport', async () => {
        const captured: Array<Parameters<AnalysisEmailTransport['send']>[0]> = [];
        const transport: AnalysisEmailTransport = {
            async send(opts) { captured.push(opts); return {}; },
        };

        const telemetryBuilder = new TelemetryBuilder(signalFetcher, sectorsFetcher, noopLogger);
        const sanityChecker    = new SanityChecker();
        const renderers: Record<string, StrategyRenderer> = {
            factor_rank_v1: new FactorRankRenderer(llm, noopLogger),
        };
        const fallback = new GenericRenderer(llm, noopLogger);

        const sender = new AnalysisEmailSender(
            { toEmail: 'op@example.com', fromEmail: 'trader@example.com', portalBaseUrl: 'http://portal' },
            profiles, telemetryBuilder, sanityChecker, renderers, fallback, transport, noopLogger,
        );

        await sender.send(makeBatch());

        expect(captured).toHaveLength(1);
        const { subject, html, to, from } = captured[0]!;
        expect(to).toBe('op@example.com');
        expect(from).toBe('trader@example.com');
        expect(subject).toMatch(/factor_rank_v1/);
        expect(subject).toMatch(/Cycle —/);

        // Telemetry numbers anchored in the email
        expect(html).toContain('Telemetry');
        expect(html).toContain('buys=2');           // signals roll-up
        expect(html).toContain('£1000.00');         // NAV from snapshot
        expect(html).toContain('NAV £1000.00');
        // Sanity flag — cold-start regime (sentinel 0.5) is expected to fire CONFIDENCE_SINGLETON_FALLBACK
        // (composite has only 2 positives < 5) and REGIME_COLD_START.
        expect(html).toContain('Sanity flags');
        expect(html).toContain('REGIME_COLD_START');
        expect(html).toContain('CONFIDENCE_SINGLETON_FALLBACK');
        // FactorRank-specific section landed
        expect(html).toContain('Factor dominance per pick');
        expect(html).toContain('Cross-sectional dispersion');
        // Per-signal block + LLM narrative
        expect(html).toContain('AAPL_US_EQ');
        expect(html).toContain('Apple Inc.');
        expect(html).toContain('momentum-dominated');
        // Portal link uses the configured base
        expect(html).toContain('http://portal/signals/');
    });

    it('falls back to GenericRenderer when no specific renderer is registered for strategyId', async () => {
        const captured: Array<Parameters<AnalysisEmailTransport['send']>[0]> = [];
        const transport: AnalysisEmailTransport = {
            async send(opts) { captured.push(opts); return {}; },
        };
        const sender = new AnalysisEmailSender(
            { toEmail: 't@e.com' }, profiles,
            new TelemetryBuilder(signalFetcher, sectorsFetcher, noopLogger),
            new SanityChecker(), {}, new GenericRenderer(llm, noopLogger),
            transport, noopLogger,
        );
        const batch = makeBatch();
        batch.strategyId = 'mystery_strategy';
        for (const s of batch.signals) s.strategy_id = 'mystery_strategy';
        batch.cycleKey = 'mystery_strategy:per_cycle:0';

        await sender.send(batch);
        // Generic path emits no strategy-specific sections — but telemetry + narrative survive.
        const html = captured[0]!.html;
        expect(html).not.toContain('Factor dominance per pick');
        expect(html).toContain('Telemetry');
        expect(html).toContain('momentum-dominated');   // narrative still injected
    });

    it('throws when the transport returns an error', async () => {
        const transport: AnalysisEmailTransport = {
            async send() { return { error: { statusCode: 500, message: 'down' } }; },
        };
        const sender = new AnalysisEmailSender(
            { toEmail: 't@e.com' }, profiles,
            new TelemetryBuilder(signalFetcher, sectorsFetcher, noopLogger),
            new SanityChecker(), { factor_rank_v1: new FactorRankRenderer(llm, noopLogger) },
            new GenericRenderer(llm, noopLogger), transport, noopLogger,
        );
        await expect(sender.send(makeBatch())).rejects.toThrow(/analysis email transport/);
    });
});
