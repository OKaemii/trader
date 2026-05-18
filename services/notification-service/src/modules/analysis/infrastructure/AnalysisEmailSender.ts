import { Resend } from 'resend';
import type { Logger } from '@trader/core';
import type { TradeSignalDTO } from '@trader/shared-types';
import type { CompanyProfile, CompanyProfileService } from '../application/CompanyProfileService.ts';
import type { DeepSeekClient } from './DeepSeekClient.ts';
import type { CycleBatch } from '../application/CycleAnalysisBatcher.ts';

export interface AnalysisEmailSenderOptions {
    apiKey:    string;
    toEmail:   string;
    fromEmail?: string;
    portalBaseUrl?: string;
}

interface SectorRollup {
    sector:   string;
    tickers:  string[];
    avgScore: number;
}

interface EnrichedSignal {
    signal:  TradeSignalDTO;
    profile: CompanyProfile | null;
    sector:  string;
    score:   number;
    rationale: { plain_english?: string; economic_mechanism?: string; uncertainty?: string };
}

// One consolidated email per strategy cycle. Layout:
//   1. Header — strategy_id, regime confidence, position-size multiplier, # actions
//   2. Cycle context paragraph — LLM-generated, ties the picks together. References any
//      sector concentration, regime, and the relationship between picks.
//   3. Per-signal blocks — action, ticker, weight, confidence, entryPrice, company
//      profile (history / market position / differentiator), and the strategy's plain
//      rationale for that single pick.
//   4. Sector roll-up table — for each sector touched, which picks landed there and
//      their average composite_score. Helps the reader see the cross-pick story.
export class AnalysisEmailSender {
    private readonly resend:        Resend;
    private readonly to:            string;
    private readonly from:          string;
    private readonly portalBaseUrl: string;

    constructor(
        opts: AnalysisEmailSenderOptions,
        private readonly profiles: CompanyProfileService,
        private readonly llm:      DeepSeekClient,
        private readonly logger:   Logger,
    ) {
        this.resend        = new Resend(opts.apiKey);
        this.to            = opts.toEmail;
        this.from          = opts.fromEmail     ?? 'trader@resend.dev';
        this.portalBaseUrl = opts.portalBaseUrl ?? 'http://trader.local';
    }

    async send(batch: CycleBatch): Promise<void> {
        const enriched = await this.enrich(batch.signals);
        const sectorRollup = this.rollupBySector(enriched);
        const cycleContext = await this.generateCycleContext(batch, enriched, sectorRollup);

        const subject = `Cycle digest — ${batch.signals.length} action(s) — ${batch.strategyId}`;
        const html    = this.renderHtml({ batch, enriched, sectorRollup, cycleContext });

        const { error } = await this.resend.emails.send({
            from: this.from, to: this.to, subject, html,
        });
        if (error) throw new Error(`Resend (analysis): ${JSON.stringify(error)}`);
        this.logger.info({
            cycleKey:    batch.cycleKey,
            signalCount: batch.signals.length,
            sectors:     sectorRollup.length,
        }, 'analysis email sent');
    }

    private async enrich(signals: TradeSignalDTO[]): Promise<EnrichedSignal[]> {
        const out: EnrichedSignal[] = [];
        // Profiles are cache-first, so 98 sequential calls is fine — first cycle pays
        // the LLM cost once per ticker, subsequent cycles hit Mongo. Parallelising would
        // burst DeepSeek; keep this serial unless we observe a problem.
        for (const signal of signals) {
            const features = signal.features_snapshot;
            const sector   = features?.sectors?.[signal.ticker] ?? 'Unknown';
            const score    = features?.composite_scores?.[signal.ticker] ?? 0;
            let parsedRationale: EnrichedSignal['rationale'];
            try { parsedRationale = JSON.parse(signal.rationale); }
            catch { parsedRationale = { plain_english: signal.rationale }; }
            const profile = await this.profiles.get(signal.ticker, sector).catch((err) => {
                this.logger.warn({ err, ticker: signal.ticker }, 'profile fetch failed; continuing without it');
                return null;
            });
            out.push({ signal, profile, sector, score, rationale: parsedRationale });
        }
        return out;
    }

    private rollupBySector(items: EnrichedSignal[]): SectorRollup[] {
        const bySector = new Map<string, { tickers: string[]; sum: number; n: number }>();
        for (const it of items) {
            const entry = bySector.get(it.sector) ?? { tickers: [], sum: 0, n: 0 };
            entry.tickers.push(it.signal.ticker);
            entry.sum += it.score;
            entry.n   += 1;
            bySector.set(it.sector, entry);
        }
        return Array.from(bySector.entries())
            .map(([sector, e]) => ({ sector, tickers: e.tickers, avgScore: e.n > 0 ? e.sum / e.n : 0 }))
            .sort((a, b) => b.tickers.length - a.tickers.length);
    }

    // One LLM call per cycle (not per ticker) that synthesises the story: why these
    // picks together, what the sector mix says, how confident the regime is, what
    // (if anything) ties them. Kept short so the email opens with a punchline.
    private async generateCycleContext(
        batch: CycleBatch,
        enriched: EnrichedSignal[],
        sectorRollup: SectorRollup[],
    ): Promise<string> {
        const head = enriched[0];
        const features = head?.signal.features_snapshot;
        const regime    = features?.regime_confidence;
        const sizeMult  = features?.position_size_multiplier;
        const picksList = enriched.map((e) =>
            `${e.signal.action} ${e.signal.ticker} (sector=${e.sector}, score=${e.score.toFixed(3)}, weight=${(e.signal.targetWeight*100).toFixed(2)}%, conf=${(e.signal.confidence*100).toFixed(0)}%)`,
        ).join('\n');
        const sectorList = sectorRollup.map((s) =>
            `${s.sector}: ${s.tickers.length} pick(s), avg_score=${s.avgScore.toFixed(3)}, tickers=${s.tickers.join(',')}`,
        ).join('\n');

        const prompt = `You are a sell-side strategist. In 3-4 short paragraphs, explain to a portfolio manager what this set of trade signals collectively says about the market right now.

Strategy: ${batch.strategyId}
Regime confidence: ${regime ?? 'unknown'} (0..1; higher = stable)
Position-size multiplier: ${sizeMult ?? 1}
Number of actions: ${enriched.length}

Picks:
${picksList}

Sector breakdown:
${sectorList}

Cover:
1. The dominant theme (sector concentration, factor tilt, market view)
2. Why these picks make sense TOGETHER (relationships, what they jointly express)
3. What the regime + position-size multiplier say about conviction
4. Notable absences or single-name standouts

Keep it tight: 3-4 paragraphs, no bullet points, professional analyst voice.`;

        try {
            return await this.llm.chat({
                messages:   [{ role: 'user', content: prompt }],
                maxTokens:  900,
                temperature: 0.5,
            });
        } catch (err) {
            this.logger.warn({ err, cycleKey: batch.cycleKey }, 'cycle-context LLM failed; falling back to template');
            return `Cycle ${batch.strategyId} produced ${enriched.length} action(s) across ${sectorRollup.length} sector(s). Regime confidence: ${regime ?? 'n/a'}.`;
        }
    }

    private renderHtml(args: {
        batch:         CycleBatch;
        enriched:      EnrichedSignal[];
        sectorRollup:  SectorRollup[];
        cycleContext:  string;
    }): string {
        const { batch, enriched, sectorRollup, cycleContext } = args;
        const cycleTime = new Date(batch.cycleTs).toISOString();

        const sectorTableRows = sectorRollup.map((s) => `
            <tr>
                <td>${escapeHtml(s.sector)}</td>
                <td style="text-align:center">${s.tickers.length}</td>
                <td style="text-align:right">${s.avgScore.toFixed(3)}</td>
                <td>${escapeHtml(s.tickers.join(', '))}</td>
            </tr>`).join('');

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
            <h2 style="margin:0 0 4px 0">Cycle digest — ${escapeHtml(batch.strategyId)}</h2>
            <p style="margin:0 0 16px 0;color:#666;font-size:13px">${cycleTime} · ${enriched.length} action(s) · ${sectorRollup.length} sector(s)</p>

            <div style="background:#f5f5f7;border-radius:6px;padding:14px;margin:0 0 18px 0">
                <h3 style="margin:0 0 8px 0;font-size:15px">Why these picks, together</h3>
                <div style="font-size:14px;line-height:1.55;white-space:pre-wrap">${escapeHtml(cycleContext)}</div>
            </div>

            <h3 style="margin:18px 0 8px 0;font-size:15px">Sector breakdown</h3>
            <table cellpadding="6" style="border-collapse:collapse;font-size:13px;width:100%">
                <thead><tr style="background:#fafafa">
                    <th align="left">Sector</th><th>Picks</th><th align="right">Avg score</th><th align="left">Tickers</th>
                </tr></thead>
                <tbody>${sectorTableRows}</tbody>
            </table>

            <h3 style="margin:22px 0 4px 0;font-size:15px">Per-signal detail</h3>
            ${signalBlocks}
        </div>`;
    }
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
