import type { Logger } from '@trader/core';
import type { CycleBatch } from '../CycleAnalysisBatcher.ts';
import type {
    ReportContext, SanityFlag, StrategyRenderer, TelemetryBlock,
} from '../ReportContext.ts';
import { buildNarrative, formatWindowLabel, type NarrativeLLM } from './utils.ts';

// Fallback renderer for any strategy without a dedicated implementation. Builds the same
// shape as the typed renderers (telemetry + sanity + narrative) but skips strategy-specific
// sections. New strategies ship through this path until someone writes a dedicated
// renderer for them — no behaviour gap, just no bespoke chart.
//
// Why no `sectionsHtml`: the email skeleton in AnalysisEmailSender already renders
// telemetry + sanity. The "sections" slot is reserved for renderer-specific blocks
// (factor dominance, betti curve, …) and the Generic path has none.
export class GenericRenderer implements StrategyRenderer {
    readonly strategyId = 'generic';

    constructor(
        private readonly llm: NarrativeLLM,
        private readonly logger: Logger,
    ) {}

    async build(batch: CycleBatch, telemetry: TelemetryBlock, sanity: SanityFlag[]): Promise<ReportContext> {
        const windowLabel = formatWindowLabel(batch);
        let narrative: string;
        try {
            narrative = await buildNarrative(this.llm, {
                strategyId: batch.strategyId,
                windowLabel, batch, telemetry, sanity,
            });
        } catch (err) {
            this.logger.warn({ err, cycleKey: batch.cycleKey }, 'generic-renderer: narrative LLM failed; falling back to template');
            narrative = fallbackNarrative(batch, telemetry, sanity);
        }
        return {
            strategyId: batch.strategyId,
            windowLabel,
            telemetry,
            sanity,
            narrative,
            sectionsHtml: '',
        };
    }
}

// Template narrative used when the LLM call fails. Keeps the email coherent enough to
// open without prose, anchored to the same numbers the LLM would have referenced.
function fallbackNarrative(batch: CycleBatch, t: TelemetryBlock, sanity: SanityFlag[]): string {
    const lines = [
        `Cycle ${batch.strategyId} produced ${t.signals.total} action(s) (BUY ${t.signals.buys} / SELL ${t.signals.sells} / HOLD ${t.signals.holds}).`,
        `Open exposure: NAV £${t.openExposure.navGbp.toFixed(2)} · HHI ${t.openExposure.hhi.toFixed(3)} · top-3 ${(t.openExposure.top3Concentration*100).toFixed(1)}%.`,
        `Regime confidence ${t.regime.confidence === null ? 'unknown' : t.regime.confidence.toFixed(3)}; decay state ${t.decay.health}.`,
    ];
    const crit = sanity.filter((f) => f.severity === 'critical');
    if (crit.length > 0) {
        lines.push(`Critical anomalies: ${crit.map((f) => f.code).join(', ')}. See sanity block.`);
    }
    return lines.join(' ');
}
