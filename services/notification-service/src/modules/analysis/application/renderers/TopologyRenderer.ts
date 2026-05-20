import type { Logger } from '@trader/core';
import type { StrategyOutput } from '@trader/shared-types';
import type { CycleBatch } from '../CycleAnalysisBatcher.ts';
import {
    mergeBatchFeatures,
    type ReportContext, type SanityFlag, type StrategyRenderer, type TelemetryBlock,
} from '../ReportContext.ts';
import {
    buildNarrative, escapeHtml, formatWindowLabel, type NarrativeLLM,
} from './utils.ts';

// Renderer for topology_v1. The TDA strategy carries three pieces of structure the
// operator wants explained on every cycle:
//   - Betti curves β₀(ε), β₁(ε): how many connected components and loops survive at
//     each filtration radius. Visualised as a textual sparkline of β₁.
//   - Persistence pairs (birth, death, dim): top-3 by lifetime tells the operator
//     which structural features survived longest in the filtration.
//   - Laplacian residuals per ticker: the spectral signal that drove each pick.
//
// Strategy-specific sanity rules:
//   TOPOLOGY_GATED                 — signal_weights.topology < 0.05 (regime fades topology)
//   BETTI_EMPTY                    — max(β₁) === 0 (no loops detected this cycle)
//   LAPLACIAN_RESIDUALS_DEGENERATE — every residual is 0 (diffusion math collapsed)
const TOPOLOGY_GATE_FLOOR = 0.05;

export class TopologyRenderer implements StrategyRenderer {
    readonly strategyId = 'topology_v1';

    constructor(
        private readonly llm: NarrativeLLM,
        private readonly logger: Logger,
    ) {}

    async build(batch: CycleBatch, telemetry: TelemetryBlock, sanity: SanityFlag[]): Promise<ReportContext> {
        const head = mergeBatchFeatures(batch);
        const extraFlags = head ? this.strategyRules(head) : [];
        const allFlags   = [...sanity, ...extraFlags];

        const windowLabel = formatWindowLabel(batch);
        const sectionsHtml = head
            ? renderTopologySections(batch, head)
            : `<p style="color:#888;font-style:italic">No features_snapshot — topology sections unavailable.</p>`;

        let narrative: string;
        try {
            narrative = await buildNarrative(this.llm, {
                strategyId: batch.strategyId,
                windowLabel, batch, telemetry, sanity: allFlags,
                extraContext: head ? topologyContextString(batch, head) : undefined,
            });
        } catch (err) {
            this.logger.warn({ err, cycleKey: batch.cycleKey }, 'topology-renderer: narrative LLM failed; falling back to template');
            narrative = `Topology cycle ${batch.strategyId} produced ${telemetry.signals.total} action(s).`;
        }

        return {
            strategyId: batch.strategyId,
            windowLabel, telemetry,
            sanity: allFlags,
            narrative,
            sectionsHtml,
        };
    }

    strategyRules(head: StrategyOutput): SanityFlag[] {
        const out: SanityFlag[] = [];
        const topoWeight = head.signal_weights?.topology;
        if (typeof topoWeight === 'number' && topoWeight < TOPOLOGY_GATE_FLOOR) {
            out.push({
                severity: 'info',
                code: 'TOPOLOGY_GATED',
                message: `Topology weight is ${topoWeight.toFixed(3)} (<${TOPOLOGY_GATE_FLOOR}) — the regime gate has faded topology this cycle.`,
                hint: 'Picks this cycle are driven by the residual factor blend, not by topology features. Expect this in low-stability regimes.',
                evidence: { topologyWeight: topoWeight },
            });
        }
        const beta1 = head.betti_curves?.beta1 ?? [];
        if (beta1.length > 0 && Math.max(...beta1) === 0) {
            out.push({
                severity: 'warn',
                code: 'BETTI_EMPTY',
                message: 'No β₁ loops detected at any filtration radius this cycle.',
                hint: 'Topology has no second-order signal to add. The strategy is operating on β₀-only structure (connected components).',
                evidence: { beta1Max: 0, n: beta1.length },
            });
        }
        const residuals = Object.values(head.laplacian_residuals ?? {});
        if (residuals.length > 0 && residuals.every((v) => v === 0)) {
            out.push({
                severity: 'critical',
                code: 'LAPLACIAN_RESIDUALS_DEGENERATE',
                message: `All ${residuals.length} Laplacian residuals are 0 — the diffusion solve collapsed.`,
                hint: 'Inspect the Laplacian construction for an all-zeros adjacency or rank-deficient graph; downstream picks are spurious.',
                evidence: { n: residuals.length },
            });
        }
        return out;
    }
}

// ── HTML sections ─────────────────────────────────────────────────────────

function renderTopologySections(batch: CycleBatch, head: StrategyOutput): string {
    return [
        renderBettiSparkline(head),
        renderPersistencePairs(head),
        renderLaplacianResiduals(batch, head),
    ].filter(Boolean).join('\n');
}

function renderBettiSparkline(head: StrategyOutput): string {
    const curves = head.betti_curves;
    if (!curves || curves.beta1.length === 0) return '';
    const beta1 = curves.beta1;
    const epsRange = curves.epsilon_range;
    const max = Math.max(1, ...beta1);
    // 8-line vertical sparkline using Unicode block characters — readable in any
    // monospace text rendering, no SVG, no images.
    const blocks = '▁▂▃▄▅▆▇█';
    const spark  = beta1.map((v) => {
        const idx = Math.min(blocks.length - 1, Math.floor((v / max) * (blocks.length - 1)));
        return blocks[idx] ?? '▁';
    }).join('');
    const epsLo = epsRange[0] ?? 0;
    const epsHi = epsRange[epsRange.length - 1] ?? 0;
    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">β₁ across filtration</h3>
        <pre style="font-family:monospace;font-size:14px;margin:4px 0">${escapeHtml(spark)}</pre>
        <p style="margin:0;font-size:12px;color:#666">ε ∈ [${epsLo.toFixed(3)}, ${epsHi.toFixed(3)}] · n=${beta1.length} · max β₁=${Math.max(...beta1)}</p>
    </div>`;
}

function renderPersistencePairs(head: StrategyOutput): string {
    const pairs = head.persistence_pairs ?? [];
    if (pairs.length === 0) return '';
    // (birth, death, dim) — sort by lifetime desc, take top 3. Operator wants the
    // longest-lived structural features; short pairs are typically noise.
    const top = pairs
        .map(([birth, death, dim]) => ({ birth, death, dim, lifetime: death - birth }))
        .sort((a, b) => b.lifetime - a.lifetime)
        .slice(0, 3);
    const rows = top.map((p) => `
        <tr><td>${p.dim}</td><td>${p.birth.toFixed(3)}</td><td>${p.death.toFixed(3)}</td><td><b>${p.lifetime.toFixed(3)}</b></td></tr>`).join('');
    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Top persistence pairs</h3>
        <table cellpadding="4" style="border-collapse:collapse;font-size:12px">
            <thead><tr style="background:#fafafa"><th>dim</th><th>birth</th><th>death</th><th>lifetime</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function renderLaplacianResiduals(batch: CycleBatch, head: StrategyOutput): string {
    const residuals = head.laplacian_residuals;
    if (!residuals) return '';
    // Bar gauge per pick, normalised to the maximum absolute residual in the cycle.
    const pickResiduals = batch.signals
        .map((s) => ({ ticker: s.ticker, value: residuals[s.ticker] ?? 0 }));
    const max = Math.max(1e-9, ...pickResiduals.map((p) => Math.abs(p.value)));
    const rows = pickResiduals.map((p) => {
        const pct = Math.min(100, (Math.abs(p.value) / max) * 100);
        const color = p.value >= 0 ? '#2980b9' : '#c0392b';
        return `<tr>
            <td style="font-family:monospace;font-size:12px;padding-right:8px">${escapeHtml(p.ticker)}</td>
            <td style="width:200px"><div style="background:${color};width:${pct}%;height:10px"></div></td>
            <td style="font-size:12px;padding-left:8px">${p.value.toFixed(4)}</td>
        </tr>`;
    }).join('');
    return `
    <div style="margin:14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Per-pick Laplacian residual</h3>
        <table cellpadding="2" style="border-collapse:collapse">${rows}</table>
    </div>`;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function topologyContextString(batch: CycleBatch, head: StrategyOutput): string {
    const beta1 = head.betti_curves?.beta1 ?? [];
    const topoWeight = head.signal_weights?.topology;
    const residuals = Object.values(head.laplacian_residuals ?? {});
    return [
        beta1.length > 0 ? `Max β₁=${Math.max(...beta1)} across ${beta1.length} filtration steps` : null,
        typeof topoWeight === 'number' ? `Topology gate weight: ${topoWeight.toFixed(3)}` : null,
        residuals.length > 0 ? `Laplacian residual range: [${Math.min(...residuals).toFixed(3)}, ${Math.max(...residuals).toFixed(3)}]` : null,
    ].filter(Boolean).join('. ');
}
