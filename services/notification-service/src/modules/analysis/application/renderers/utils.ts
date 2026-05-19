import type { Cadence, CycleBatch } from '../CycleAnalysisBatcher.ts';
import type { ChatCompletionOptions } from '../../infrastructure/DeepSeekClient.ts';
import type { SanityFlag, TelemetryBlock } from '../ReportContext.ts';

// Narrow LLM surface — anything that has `.chat(req)` plugs in. Lets tests pass a stub
// instead of needing a real DeepSeekClient + API key.
export interface NarrativeLLM {
    chat(req: ChatCompletionOptions): Promise<string>;
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Window label is renderer-agnostic; e.g. "Daily — 2026-05-18" or "Hourly digest 14:00–15:00 UTC".
// Used in the email subject and header. Derived purely from cadence + bucket timestamps so
// renderers don't drift on labelling conventions.
export function formatWindowLabel(batch: CycleBatch): string {
    const cadence: Cadence = batch.cadence;
    const start = new Date(batch.cycleTs);
    if (cadence === 'per_cycle') {
        return `Cycle — ${start.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    }
    if (cadence === 'eod') {
        const day = start.toISOString().slice(0, 10);
        const mkt = batch.market ?? 'OTHER';
        return `EOD ${mkt} — ${day}`;
    }
    const windowMs = cadence === 'hourly' ? 60 * 60_000 : 4 * 60 * 60_000;
    const end = new Date(start.getTime() + windowMs);
    const fmt = (d: Date) => d.toISOString().slice(11, 16);
    return `${cadence === 'hourly' ? 'Hourly' : 'Four-hourly'} digest ${fmt(start)}–${fmt(end)} UTC ${start.toISOString().slice(0, 10)}`;
}

// Builds the LLM prompt. Telemetry + sanity are passed in as JSON; the prompt locks
// the model to "only restate or interpret numbers below" — hallucination becomes a
// post-render signal we can flag rather than the default failure mode.
export interface NarrativeRequest {
    strategyId:   string;
    windowLabel:  string;
    batch:        CycleBatch;
    telemetry:    TelemetryBlock;
    sanity:       SanityFlag[];
    extraContext?: string | undefined;   // strategy-specific addendum (factor mix, betti curve summary, …)
}

export async function buildNarrative(llm: NarrativeLLM, req: NarrativeRequest): Promise<string> {
    // Pre-humanise the duration field the LLM tends to quote verbatim. Raw `ms ago`
    // leaked into the first Phase 8 output ("prior digest was 1,012,980 ms ago"); we
    // surface a `timeSinceLastDigestLabel: "0.3h"` field next to the raw ms so the
    // model has a natural-language version to grab without us having to fight it
    // post-hoc on every iteration.
    const enrichedTelemetry = {
        ...req.telemetry,
        history: {
            ...req.telemetry.history,
            timeSinceLastDigestLabel: humaniseDuration(req.telemetry.history.timeSinceLastDigestMs),
        },
    };
    const telemetryJson = JSON.stringify(enrichedTelemetry, null, 2);
    const sanityJson    = JSON.stringify(req.sanity,    null, 2);
    const picks = req.batch.signals.map((s) => {
        const prior = req.telemetry.history.priorAppearances[s.ticker];
        return {
            action: s.action, ticker: s.ticker,
            confidence:   Number(s.confidence.toFixed(3)),
            targetWeight: Number(s.targetWeight.toFixed(4)),
            score:        Number((s.features_snapshot?.composite_scores?.[s.ticker] ?? 0).toFixed(3)),
            sector:       s.features_snapshot?.sectors?.[s.ticker] ?? 'Unknown',
            priorAppearance: prior ? {
                action:    prior.action,
                ageDays:   Number(prior.ageDays.toFixed(1)),
                lifecycle: prior.lifecycle,
                pnlPct:    prior.pnlPct === null ? null : Number(prior.pnlPct.toFixed(4)),
            } : null,
        };
    });

    // Curated prompt. Three rules drive the rewrite from the previous version:
    //   1. Headline-first — one sentence captures the single most important thing about
    //      this window. Operator scanning their inbox sees the punchline immediately.
    //   2. Forbid generic adjectives — "balanced/moderate/cautious/supportive" are filler
    //      that say nothing. Specific numbers + their implications only.
    //   3. Force comparison to history when present — every paragraph must reference
    //      `telemetry.history` or a prior appearance, OR a specific number from
    //      TELEMETRY. No floating prose.
    // The "watch next" close converts the report from descriptive → actionable: name one
    // observation that would change the read.
    const prompt = `You are a sell-side strategist writing a cycle digest for a quant operator.

WINDOW: ${req.windowLabel}
STRATEGY: ${req.strategyId}

PICKS (${picks.length}, each with prior appearance if any):
${JSON.stringify(picks, null, 2)}

TELEMETRY (pre-computed — the ONLY numbers you may cite):
${telemetryJson}

SANITY FLAGS:
${sanityJson}
${req.extraContext ? `\nSTRATEGY-SPECIFIC CONTEXT:\n${req.extraContext}\n` : ''}
WRITE the digest in EXACTLY this shape:

  First line: one sentence, max 25 words, naming the single most important thing about
  THIS window. No throat-clearing. No label prefix — just the sentence. Do NOT prefix
  it with "Headline:", "**Headline:**", or any other marker.

  Then 2–3 short paragraphs covering:
    • What changed vs the prior digest (use telemetry.history.signalsSinceLastDigest,
      telemetry.history.timeSinceLastDigestMs, and the priorAppearance of each pick).
      If history is empty, say "first digest" explicitly.
    • What the picks ARGUE — refer to specific telemetry numbers AND prior appearances.
      A pick whose predecessor closed +X% means something different than a pick on a
      fresh ticker; say so.
    • Critical anomalies from SANITY only. Skip info/warn unless they materially change
      the read.

  Final line — WATCH NEXT: one sentence naming the specific number or event that would
  invalidate the read. Start with "Watch:".

HARD RULES:
- Never invent numbers. Every figure must trace to TELEMETRY, SANITY, or PICKS.
- Express durations as hours or days (use telemetry.history.timeSinceLastDigestLabel
  when referring to the gap since the prior digest). NEVER quote raw milliseconds.
- Banned filler words: "balanced", "moderate", "cautious", "supportive", "robust",
  "solid", "healthy" (the decay-health field can be quoted, but don't editorialise
  with it). If you need an adjective, replace it with the number.
- No bullet points. No markdown headers, bold, or italics. No "in conclusion" or
  similar. Plain prose only.
- If a paragraph isn't anchored to a specific number or prior appearance, delete it.`;

    return llm.chat({
        messages:    [{ role: 'user', content: prompt }],
        maxTokens:   900,
        temperature: 0.3,
    });
}

// Render a SanityFlag list as an HTML block. Critical → red, warn → amber, info → grey.
// Strategy renderers concatenate this above their own sectionsHtml; AnalysisEmailSender
// renders it again at the top of the email to guarantee anomalies aren't buried.
export function renderSanityHtml(flags: SanityFlag[]): string {
    if (flags.length === 0) return '';
    const color = (sev: SanityFlag['severity']) =>
        sev === 'critical' ? '#c0392b' :
        sev === 'warn'     ? '#b58900' :
                             '#586e75';
    const rows = flags.map((f) => `
        <div style="border-left:4px solid ${color(f.severity)};padding:6px 10px;margin:4px 0;background:#fafafa">
            <b style="color:${color(f.severity)};text-transform:uppercase;font-size:11px">${escapeHtml(f.severity)}</b>
            <code style="font-size:11px;color:#666;margin-left:6px">${escapeHtml(f.code)}</code>
            <div style="font-size:13px;margin-top:2px">${escapeHtml(f.message)}</div>
            ${f.hint ? `<div style="font-size:12px;color:#666;font-style:italic;margin-top:2px">${escapeHtml(f.hint)}</div>` : ''}
        </div>`).join('');
    return `<div style="margin:10px 0 14px 0"><h3 style="margin:0 0 6px 0;font-size:14px">Sanity flags</h3>${rows}</div>`;
}

// Convert ms-since-last-digest to a human label the LLM can safely quote.
// Mirrors renderHistoryRow's heuristic so the prose and the inline row agree.
function humaniseDuration(ms: number | null): string | null {
    if (ms === null) return null;
    const hours = ms / 3_600_000;
    return hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

// "vs last digest" row appended to the telemetry table. Surfaces previousDigestAt
// (formatted relative) + signalsSinceLastDigest so the operator sees how big a gap
// the digest spans without leaving the email.
function renderHistoryRow(h: TelemetryBlock['history']): string {
    if (h.previousDigestAt === null) {
        return `<tr><td><b>vs last digest</b></td><td><i>first digest for this strategy</i></td></tr>`;
    }
    const hours = (h.timeSinceLastDigestMs ?? 0) / 3_600_000;
    const ago   = hours >= 24 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
    return `<tr><td><b>vs last digest</b></td><td>${ago} ago · ${h.signalsSinceLastDigest} signal(s) in between</td></tr>`;
}

// Render a TelemetryBlock as a compact HTML table. The narrative riffs on these numbers;
// rendering them inline lets the operator verify each claim without leaving the email.
export function renderTelemetryHtml(t: TelemetryBlock): string {
    const fmtMoney = (n: number) => `£${n.toFixed(2)}`;
    const fmtPct   = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
    const fmtNum   = (n: number | null) => n === null ? '—' : n.toFixed(3);
    const bySectorRows = t.signals.bySector.map((s) => `
        <tr><td>${escapeHtml(s.sector)}</td><td style="text-align:center">${s.n}</td>
            <td style="text-align:right">${fmtPct(s.avgConfidence)}</td>
            <td style="text-align:right">${s.avgScore.toFixed(3)}</td></tr>`).join('');

    const best  = t.realisedSinceLast.bestPick;
    const worst = t.realisedSinceLast.worstPick;

    return `
    <div style="margin:10px 0 14px 0">
        <h3 style="margin:0 0 6px 0;font-size:14px">Telemetry</h3>
        <table cellpadding="4" style="border-collapse:collapse;font-size:12px;width:100%">
            <tr style="background:#fafafa">
                <td><b>Signals</b></td>
                <td>buys=${t.signals.buys} sells=${t.signals.sells} holds=${t.signals.holds} (total ${t.signals.total})</td>
            </tr>
            <tr>
                <td><b>Realised since last</b></td>
                <td>closed=${t.realisedSinceLast.closedSignals} · P&amp;L ${fmtMoney(t.realisedSinceLast.pnlGbp)}${best ? ` · best ${escapeHtml(best.ticker)} ${(best.pnlPct*100).toFixed(2)}%` : ''}${worst ? ` · worst ${escapeHtml(worst.ticker)} ${(worst.pnlPct*100).toFixed(2)}%` : ''}</td>
            </tr>
            <tr style="background:#fafafa">
                <td><b>Open exposure</b></td>
                <td>NAV ${fmtMoney(t.openExposure.navGbp)} · cash≈${fmtPct(t.openExposure.cashFractionApprox)} · top3=${(t.openExposure.top3Concentration*100).toFixed(1)}% · HHI=${t.openExposure.hhi.toFixed(3)}</td>
            </tr>
            <tr>
                <td><b>Regime</b></td>
                <td>conf=${fmtNum(t.regime.confidence)} · size×=${fmtNum(t.regime.positionSizeMultiplier)}${t.regime.coldStart ? ' · <b style="color:#b58900">cold-start</b>' : ''}</td>
            </tr>
            <tr style="background:#fafafa">
                <td><b>Decay</b></td>
                <td>${escapeHtml(t.decay.health)} · multiplier=${t.decay.multiplier.toFixed(2)} · IC₃₀ₐ=${fmtNum(t.decay.ic_30d)}</td>
            </tr>
            <tr>
                <td><b>Universe</b></td>
                <td>active=${t.universe.activeCount} · ready=${t.universe.readyCount} · unknown sector=${(t.universe.unknownSectorFraction*100).toFixed(1)}%</td>
            </tr>
            ${t.circuitBreaker.open ? `<tr style="background:#fdecea"><td><b>Circuit breaker</b></td><td><b style="color:#c0392b">OPEN</b>${t.circuitBreaker.reason ? ` — ${escapeHtml(t.circuitBreaker.reason)}` : ''}</td></tr>` : ''}
            ${renderHistoryRow(t.history)}
        </table>
        ${bySectorRows ? `<h4 style="margin:8px 0 4px 0;font-size:12px">By sector</h4>
            <table cellpadding="3" style="border-collapse:collapse;font-size:12px">
                <thead><tr style="background:#fafafa"><th align="left">Sector</th><th>n</th><th align="right">avg conf</th><th align="right">avg score</th></tr></thead>
                <tbody>${bySectorRows}</tbody>
            </table>` : ''}
    </div>`;
}
