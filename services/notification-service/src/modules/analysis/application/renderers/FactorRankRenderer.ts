import type { Logger } from '@trader/core';
import type { StrategyOutput } from '@trader/shared-types';
import type { CycleBatch } from '../CycleAnalysisBatcher.ts';
import type {
    ReportContext, SanityFlag, StrategyRenderer, TelemetryBlock,
} from '../ReportContext.ts';
import {
    buildNarrative, escapeHtml, formatWindowLabel, type NarrativeLLM,
} from './utils.ts';

// Renderer for factor_rank_v1. The cross-sectional composite is a weighted sum of
// momentum / reversal / low-vol scores per ticker. The interesting reporting questions
// are: (a) which factor dominated this cycle? (b) how dispersed are the composite
// scores — are the picks really separated from the rest of the universe, or is the
// strategy reaching for tickers that are statistically indistinguishable? (c) which
// features failed stationarity since last cycle?
//
// Strategy-specific sanity rules (in addition to the baseline set):
//   FACTOR_DEGENERATE       — composite scores have stddev < 0.01 (z-scores collapsed)
//   FACTOR_DOMINANCE_SHIFT  — same factor is the single dominant contributor for >80% of picks
const FACTOR_STDDEV_FLOOR = 0.01;
const DOMINANCE_THRESHOLD = 0.8;

export class FactorRankRenderer implements StrategyRenderer {
    readonly strategyId = 'factor_rank_v1';

    constructor(
        private readonly llm: NarrativeLLM,
        private readonly logger: Logger,
    ) {}

    async build(batch: CycleBatch, telemetry: TelemetryBlock, sanity: SanityFlag[]): Promise<ReportContext> {
        const head = batch.signals[0]?.features_snapshot;
        const extraFlags  = head ? this.strategyRules(head) : [];
        const allFlags    = [...sanity, ...extraFlags];

        const windowLabel = formatWindowLabel(batch);
        const sectionsHtml = head
            ? renderFactorSections(batch, head)
            : `<p style="color:#888;font-style:italic">No features_snapshot — strategy-specific sections unavailable.</p>`;

        let narrative: string;
        try {
            narrative = await buildNarrative(this.llm, {
                strategyId: batch.strategyId,
                windowLabel, batch, telemetry, sanity: allFlags,
                extraContext: head ? factorContextString(batch, head) : undefined,
            });
        } catch (err) {
            this.logger.warn({ err, cycleKey: batch.cycleKey }, 'factor-rank-renderer: narrative LLM failed; falling back to template');
            narrative = `Factor-rank cycle ${batch.strategyId} produced ${telemetry.signals.total} action(s); top dominant factor: ${head ? dominantFactor(batch, head) ?? 'n/a' : 'n/a'}.`;
        }

        return {
            strategyId: batch.strategyId,
            windowLabel, telemetry,
            sanity: allFlags,
            narrative,
            sectionsHtml,
        };
    }

    // Strategy-specific rule set. Tested independently of the LLM path.
    strategyRules(head: StrategyOutput): SanityFlag[] {
        const out: SanityFlag[] = [];
        const scores = Object.values(head.composite_scores ?? {});
        if (scores.length >= 2) {
            const std = stddev(scores);
            if (std < FACTOR_STDDEV_FLOOR) {
                out.push({
                    severity: 'critical',
                    code: 'FACTOR_DEGENERATE',
                    message: `Composite scores have stddev=${std.toFixed(5)} across ${scores.length} tickers — z-scores collapsed.`,
                    hint: 'Inspect factor inputs for a constant column or upstream NaN run; cross-sectional ranking is meaningless when dispersion is zero.',
                    evidence: { stddev: std, n: scores.length },
                });
            }
        }
        const dominance = pickDominanceFraction(head);
        if (dominance && dominance.fraction > DOMINANCE_THRESHOLD) {
            out.push({
                severity: 'info',
                code: 'FACTOR_DOMINANCE_SHIFT',
                message: `${(dominance.fraction * 100).toFixed(0)}% of picks are dominated by the "${dominance.factor}" factor.`,
                hint: 'The portfolio is taking a concentrated factor bet this cycle — exposure to a single factor regime change is elevated.',
                evidence: dominance,
            });
        }
        return out;
    }
}

// ── HTML sections ─────────────────────────────────────────────────────────

function renderFactorSections(batch: CycleBatch, head: StrategyOutput): string {
    return [
        renderFactorDominanceTable(batch, head),
        renderDispersionBlock(head),
        renderStabilityHeatmap(head),
    ].join('\n');
}

function renderFactorDominanceTable(batch: CycleBatch, head: StrategyOutput): string {
    const factorAttr = head.factor_attributions ?? {};
    // Union of factors observed across this cycle's picks. Sorted alphabetically for
    // stable column order — operator scanning multiple emails wants the same columns
    // in the same position.
    const factorSet = new Set<string>();
    for (const s of batch.signals) {
        for (const f of Object.keys(factorAttr[s.ticker] ?? {})) factorSet.add(f);
    }
    const factors = Array.from(factorSet).sort();
    if (factors.length === 0) {
        return `<p style="font-size:12px;color:#666;font-style:italic">No factor attributions recorded for this cycle's picks.</p>`;
    }
    const header = `<tr style="background:#fafafa"><th align="left">Ticker</th>${
        factors.map((f) => `<th align="right">${escapeHtml(f)}</th>`).join('')
    }<th align="right">composite</th></tr>`;
    const rows = batch.signals.map((s) => {
        const attr = factorAttr[s.ticker] ?? {};
        const cells = factors.map((f) => {
            const v = attr[f];
            return `<td align="right">${typeof v === 'number' ? v.toFixed(3) : '—'}</td>`;
        }).join('');
        const composite = head.composite_scores?.[s.ticker] ?? 0;
        return `<tr><td>${escapeHtml(s.ticker)}</td>${cells}<td align="right"><b>${composite.toFixed(3)}</b></td></tr>`;
    }).join('');
    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Factor dominance per pick</h3>
        <table cellpadding="4" style="border-collapse:collapse;font-size:12px">${header}${rows}</table>
    </div>`;
}

// Compact dispersion block: stddev + min/max + 5-bucket histogram (text bars).
function renderDispersionBlock(head: StrategyOutput): string {
    const scores = Object.values(head.composite_scores ?? {});
    if (scores.length === 0) return '';
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const sd  = stddev(scores);

    // 5-bucket histogram across [min, max]. Renders as filled blocks scaled to the
    // tallest bucket — readable in any email client without SVG support.
    const bins = 5;
    const width = max > min ? (max - min) / bins : 1;
    const counts = new Array(bins).fill(0);
    for (const v of scores) {
        if (max === min) { counts[0] += 1; continue; }
        const idx = Math.min(bins - 1, Math.floor((v - min) / width));
        counts[idx] += 1;
    }
    const peak = Math.max(1, ...counts);
    const bars = counts.map((c, i) => {
        const lo = (min + i * width).toFixed(2);
        const hi = (min + (i + 1) * width).toFixed(2);
        const blocks = '▓'.repeat(Math.round((c / peak) * 10));
        return `<tr><td style="font-family:monospace;font-size:11px">${lo}–${hi}</td><td style="font-family:monospace;font-size:11px">${blocks}</td><td style="text-align:right;font-size:11px">${c}</td></tr>`;
    }).join('');

    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Cross-sectional dispersion</h3>
        <p style="margin:0;font-size:12px;color:#444">n=${scores.length} · min=${min.toFixed(3)} · max=${max.toFixed(3)} · stddev=${sd.toFixed(4)}</p>
        <table cellpadding="2" style="margin-top:4px;border-collapse:collapse">${bars}</table>
    </div>`;
}

function renderStabilityHeatmap(head: StrategyOutput): string {
    const fs = head.feature_stability;
    if (!fs || fs.features.length === 0) return '';
    const cells = fs.features.map((f) => {
        const color = f.is_stationary ? '#2ecc71' : '#e67e22';
        return `<td style="background:${color};color:white;padding:4px 8px;font-size:11px" title="cv=${f.cv.toFixed(3)}">${escapeHtml(f.name)}</td>`;
    }).join('');
    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Feature stability (green = stationary)</h3>
        <table cellpadding="0" style="border-collapse:separate;border-spacing:4px"><tr>${cells}</tr></table>
        <p style="margin:4px 0 0 0;font-size:12px;color:#666">stability_score=${fs.stability_score.toFixed(3)} · n_unstable=${fs.n_unstable}</p>
    </div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function factorContextString(batch: CycleBatch, head: StrategyOutput): string {
    const dom = dominantFactor(batch, head);
    const scores = Object.values(head.composite_scores ?? {});
    return [
        dom ? `Dominant factor across picks: ${dom}` : null,
        scores.length >= 2 ? `Composite stddev across universe: ${stddev(scores).toFixed(4)}` : null,
        head.feature_stability ? `Stability: ${head.feature_stability.n_unstable} feature(s) non-stationary` : null,
    ].filter(Boolean).join('. ');
}

function dominantFactor(batch: CycleBatch, head: StrategyOutput): string | null {
    const dom = pickDominanceFraction(head);
    return dom?.factor ?? null;
}

function pickDominanceFraction(head: StrategyOutput): { factor: string; fraction: number; n: number } | null {
    const attr = head.factor_attributions ?? {};
    const tickers = Object.keys(attr);
    if (tickers.length === 0) return null;
    const factorWins = new Map<string, number>();
    for (const t of tickers) {
        const f = topFactorFor(attr[t] ?? {});
        if (!f) continue;
        factorWins.set(f, (factorWins.get(f) ?? 0) + 1);
    }
    let best: { factor: string; count: number } | null = null;
    for (const [factor, count] of factorWins) {
        if (!best || count > best.count) best = { factor, count };
    }
    if (!best) return null;
    return { factor: best.factor, fraction: best.count / tickers.length, n: tickers.length };
}

function topFactorFor(row: Record<string, number>): string | null {
    let best: { f: string; v: number } | null = null;
    for (const [f, v] of Object.entries(row)) {
        const abs = Math.abs(v);
        if (!best || abs > best.v) best = { f, v: abs };
    }
    return best?.f ?? null;
}

function stddev(xs: number[]): number {
    if (xs.length < 2) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
    return Math.sqrt(variance);
}
