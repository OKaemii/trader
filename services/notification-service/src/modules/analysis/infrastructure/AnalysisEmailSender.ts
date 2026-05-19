import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';
import type { CompanyProfile, CompanyProfileService } from '../application/CompanyProfileService.ts';
import type { CycleBatch } from '../application/CycleAnalysisBatcher.ts';
import type { ReportContext, StrategyRenderer } from '../application/ReportContext.ts';
import type { SanityChecker } from '../application/SanityChecker.ts';
import type { TelemetryBuilder } from '../application/TelemetryBuilder.ts';
import {
    escapeHtml, renderSanityHtml, renderTelemetryHtml,
} from '../application/renderers/utils.ts';

// Narrow transport boundary. Resend is the production impl; tests pass a fake captor.
// Avoiding `new Resend()` inside this class lets the renderHtml + send orchestration be
// exercised end-to-end without mocking the network or a third-party SDK.
export interface AnalysisEmailTransport {
    send(opts: { from: string; to: string; subject: string; html: string }): Promise<{ error?: unknown }>;
}

export interface AnalysisEmailSenderOptions {
    toEmail:        string;
    fromEmail?:     string | undefined;
    portalBaseUrl?: string | undefined;
}

interface EnrichedSignal {
    signal:    TradeSignalDTO;
    profile:   CompanyProfile | null;
    sector:    string;
    score:     number;
    rationale: { plain_english?: string; economic_mechanism?: string; uncertainty?: string };
}

// Orchestrator: per CycleBatch, builds a TelemetryBlock, runs SanityChecker, picks the
// strategy-specific renderer (or GenericRenderer fallback), assembles the email HTML
// and ships it via the configured transport. The inline cycle-context LLM prompt that
// used to live here is gone — every renderer owns its own grounded prompt now.
//
// Layout:
//   1. Header — strategy_id, cadence window label, count
//   2. Telemetry block — pre-computed numbers anchoring the narrative
//   3. Sanity flags — anomalies before prose so the operator can't miss them
//   4. Narrative — LLM prose (or template fallback) grounded in (2) + (3)
//   5. Strategy-specific sections — factor table, betti curve, sector means, …
//   6. Per-signal blocks — company profile + per-pick rationale
//   7. Portal links
export class AnalysisEmailSender {
    private readonly to:            string;
    private readonly from:          string;
    private readonly portalBaseUrl: string;

    constructor(
        opts: AnalysisEmailSenderOptions,
        private readonly profiles:         CompanyProfileService,
        private readonly telemetryBuilder: TelemetryBuilder,
        private readonly sanityChecker:    SanityChecker,
        private readonly renderers:        Record<string, StrategyRenderer>,
        private readonly fallbackRenderer: StrategyRenderer,
        private readonly transport:        AnalysisEmailTransport,
        private readonly logger:           Logger,
    ) {
        this.to            = opts.toEmail;
        this.from          = opts.fromEmail     ?? 'trader@resend.dev';
        this.portalBaseUrl = opts.portalBaseUrl ?? 'http://trader.local';
    }

    async send(batch: CycleBatch): Promise<void> {
        const telemetry = await this.telemetryBuilder.build(batch);
        const head      = batch.signals[0]?.features_snapshot;
        const sanity    = this.sanityChecker.check({
            signals: batch.signals,
            telemetry,
            headFeatures: head,
            strategyId:   batch.strategyId,
        });
        const renderer = this.renderers[batch.strategyId] ?? this.fallbackRenderer;
        const ctx      = await renderer.build(batch, telemetry, sanity);

        const enriched = await this.enrich(batch.signals, ctx);
        const subject  = `${ctx.windowLabel} — ${batch.signals.length} action(s) — ${batch.strategyId}`;
        const html     = this.renderHtml({ batch, ctx, enriched });

        const res = await this.transport.send({
            from: this.from, to: this.to, subject, html,
        });
        if (res.error) throw new Error(`analysis email transport: ${JSON.stringify(res.error)}`);
        this.logger.info({
            cycleKey:    batch.cycleKey,
            strategyId:  batch.strategyId,
            cadence:     batch.cadence,
            signalCount: batch.signals.length,
            sanity:      ctx.sanity.length,
            severities:  ctx.sanity.map((f) => f.severity),
        }, 'analysis email sent');
    }

    // ── Per-signal company profile enrichment ─────────────────────────────────
    // Kept from the previous implementation: company profiles round-trip through
    // Mongo (cache-first), so subsequent emails for the same ticker are cheap.
    private async enrich(signals: TradeSignalDTO[], ctx: ReportContext): Promise<EnrichedSignal[]> {
        const out: EnrichedSignal[] = [];
        for (const signal of signals) {
            const features = signal.features_snapshot;
            const sector   = features?.sectors?.[signal.ticker] ?? 'Unknown';
            const score    = features?.composite_scores?.[signal.ticker] ?? 0;
            let parsedRationale: EnrichedSignal['rationale'];
            try { parsedRationale = JSON.parse(signal.rationale); }
            catch { parsedRationale = { plain_english: signal.rationale }; }
            const profile = await this.profiles.get(signal.ticker, sector).catch((err) => {
                this.logger.warn({ err, ticker: signal.ticker, cycleKey: ctx.strategyId }, 'profile fetch failed; continuing without it');
                return null;
            });
            out.push({ signal, profile, sector, score, rationale: parsedRationale });
        }
        return out;
    }

    // ── Email layout ─────────────────────────────────────────────────────────

    private renderHtml(args: { batch: CycleBatch; ctx: ReportContext; enriched: EnrichedSignal[] }): string {
        const { batch, ctx, enriched } = args;
        const sanityHtml    = renderSanityHtml(ctx.sanity);
        const telemetryHtml = renderTelemetryHtml(ctx.telemetry);
        const narrativeBlock = ctx.narrative ? `
            <div style="background:#f5f5f7;border-radius:6px;padding:14px;margin:0 0 18px 0">
                <h3 style="margin:0 0 8px 0;font-size:15px">Why these picks, together</h3>
                <div style="font-size:14px;line-height:1.55;white-space:pre-wrap">${escapeHtml(ctx.narrative)}</div>
            </div>` : '';

        const signalBlocks = enriched.map((e) => {
            const sigEmoji = e.signal.action === 'BUY' ? '📈' : '📉';
            const profileBlock = e.profile ? `
                <h4 style="margin:14px 0 6px 0;color:#222">${escapeHtml(e.profile.name)}</h4>
                <p style="margin:4px 0;font-size:13px"><b>History:</b> ${escapeHtml(e.profile.history)}</p>
                <p style="margin:4px 0;font-size:13px"><b>Market position:</b> ${escapeHtml(e.profile.market_position)}</p>
                <p style="margin:4px 0;font-size:13px"><b>Differentiator vs peers:</b> ${escapeHtml(e.profile.differentiator)}</p>
            ` : `<p style="margin:4px 0;font-size:13px;color:#888"><i>Company profile unavailable.</i></p>`;
            return `
            <div style="border:1px solid #e0e0e0;border-radius:6px;padding:12px;margin:10px 0">
                <h3 style="margin:0 0 8px 0">${sigEmoji} ${escapeHtml(e.signal.action)} ${escapeHtml(e.signal.ticker)}</h3>
                <table style="font-size:13px;border-collapse:collapse" cellpadding="3">
                    <tr><td><b>Sector</b></td><td>${escapeHtml(e.sector)}</td>
                        <td style="padding-left:18px"><b>Composite score</b></td><td>${e.score.toFixed(3)}</td></tr>
                    <tr><td><b>Confidence</b></td><td>${(e.signal.confidence*100).toFixed(1)}%</td>
                        <td style="padding-left:18px"><b>Target weight</b></td><td>${(e.signal.targetWeight*100).toFixed(2)}%</td></tr>
                    <tr><td><b>Entry price</b></td><td>${e.signal.entryPrice ?? '—'}</td>
                        <td style="padding-left:18px"><b>Uncertainty</b></td><td>${escapeHtml(e.rationale.uncertainty ?? 'n/a')}</td></tr>
                </table>
                ${profileBlock}
                <p style="margin:10px 0 4px 0;font-size:13px"><b>Strategy rationale:</b> ${escapeHtml(e.rationale.plain_english ?? '')}</p>
                <p style="margin:4px 0;font-size:12px;color:#666"><i>${escapeHtml(e.rationale.economic_mechanism ?? '')}</i></p>
                <p style="margin:8px 0 0 0;font-size:12px"><a href="${this.portalBaseUrl}/signals/${e.signal.id}">Open in portal →</a></p>
            </div>`;
        }).join('');

        return `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:760px;margin:0 auto">
            <h2 style="margin:0 0 4px 0">${escapeHtml(ctx.windowLabel)} — ${escapeHtml(batch.strategyId)}</h2>
            <p style="margin:0 0 16px 0;color:#666;font-size:13px">${enriched.length} action(s) · ${ctx.sanity.length} sanity flag(s)</p>
            ${sanityHtml}
            ${telemetryHtml}
            ${narrativeBlock}
            ${ctx.sectionsHtml}
            <h3 style="margin:22px 0 4px 0;font-size:15px">Per-signal detail</h3>
            ${signalBlocks}
        </div>`;
    }
}
