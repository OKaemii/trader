import type { TradeSignalDTO, StrategyOutput } from '@trader/shared-types';
import type { CycleBatch } from './CycleAnalysisBatcher.ts';

// Single source of truth for the reporting types passed between the TelemetryBuilder,
// SanityChecker, strategy renderers, and AnalysisEmailSender. Keeping them here (rather
// than in each renderer file) so adding a new sanity rule or renderer doesn't risk
// drifting the shared shape.

export interface PickPnl {
    ticker: string;
    pnlPct: number;
    pnlGbp: number;
}

// Pre-computed numbers that anchor the LLM narrative. Every claim in the rendered email
// must trace back to a field on this block — the prompt is explicit: "do not invent any
// number that is not present here." When a field is genuinely unknowable, leave it null
// rather than substituting a default.
export interface TelemetryBlock {
    windowStart: number;
    windowEnd:   number;
    signals: {
        total: number;
        buys:  number;
        sells: number;
        holds: number;
        bySector: Array<{ sector: string; n: number; avgConfidence: number; avgScore: number }>;
    };
    realisedSinceLast: {
        closedSignals: number;
        pnlGbp:        number;
        bestPick:      PickPnl | null;
        worstPick:     PickPnl | null;
    };
    // Open (unrealised) P&L on currently-held positions — the "how are my holdings doing right
    // now" figure. Non-zero whenever positions have moved, unlike realisedSinceLast which is 0
    // until a round-trip closes. `coveredCount`/`totalCount` flag partial cost-basis coverage.
    openPnl: {
        unrealisedGbp: number;
        costBasisGbp:  number;
        coveredCount:  number;
        totalCount:    number;
    };
    openExposure: {
        navGbp:          number;
        cashFractionApprox: number | null;     // 1 - (open MTM / NAV); null when NAV is 0
        top3Concentration:  number;             // sum of top-3 |targetWeight|
        hhi:                number;             // Herfindahl on |targetWeight|
        positionsByLifecycle: Record<string, number>;
    };
    regime: {
        confidence:             number | null;
        positionSizeMultiplier: number | null;
        coldStart:              boolean;        // confidence === 0.5 sentinel
    };
    decay: {
        health:     'healthy' | 'warning' | 'degraded' | 'suspended';
        multiplier: number;                     // bounded [0,1] from health bucket
        ic_30d:     number | null;
    };
    universe: {
        activeCount:           number;
        readyCount:            number;          // currently same as activeCount until strategy-engine exposes "ready"
        unknownSectorFraction: number;
    };
    circuitBreaker: { open: boolean; reason: string | null };
    history: {
        previousDigestAt:       number | null;
        timeSinceLastDigestMs:  number | null;        // null when previousDigestAt is null
        signalsSinceLastDigest: number;
        priorAppearances:       Record<string, PriorAppearance>;
    };
}

// Per-ticker "what happened last time we picked this" — surfaced beside each pick in
// the email so the narrative can frame the new signal relative to its predecessor.
export interface PriorAppearance {
    lastSignalAt: number;
    action:       'BUY' | 'SELL' | 'HOLD';
    ageDays:      number;
    lifecycle:    string;
    pnlPct:       number | null;          // populated when prior was Closed
}

// Typed anomaly. Each rule emits one of these (or null when silent). Renderers display
// them above the LLM narrative — anomalies cannot be buried in prose where the operator
// might miss them. severity drives color/emoji; code is stable for downstream alerting.
export interface SanityFlag {
    severity: 'info' | 'warn' | 'critical';
    code:     string;
    message:  string;
    hint?:    string;
    evidence?: Record<string, unknown>;
}

export interface ReportContext {
    strategyId:    string;
    windowLabel:   string;
    telemetry:     TelemetryBlock;
    sanity:        SanityFlag[];
    narrative:     string;
    sectionsHtml:  string;
}

// One renderer per strategy_id; the dispatcher in AnalysisEmailSender falls back to
// GenericRenderer when no specific renderer is registered.
export interface StrategyRenderer {
    readonly strategyId: string;     // 'factor_rank_v1', 'topology_v1', 'sector_momentum_v1', 'generic'
    build(
        batch:     CycleBatch,
        telemetry: TelemetryBlock,
        sanity:    SanityFlag[],
    ): Promise<ReportContext>;
}

// Compact view of the head signal's features for rules + renderers that need the
// strategy-internal numbers without rummaging through `features_snapshot` everywhere.
export interface HeadFeaturesView {
    snapshot:               StrategyOutput | undefined;
    regimeConfidence:       number | null;
    positionSizeMultiplier: number | null;
    nStable:                number | null;
    nUnstable:              number | null;
    signalWeights:          Record<string, number> | null;
}

export function viewHead(batch: CycleBatch): HeadFeaturesView {
    const f = mergeBatchFeatures(batch);
    return {
        snapshot:               f,
        regimeConfidence:       f?.regime_confidence       ?? null,
        positionSizeMultiplier: f?.position_size_multiplier ?? null,
        nStable:                f?.feature_stability ? Math.max(0, f.feature_stability.features.length - (f.feature_stability.n_unstable ?? 0)) : null,
        nUnstable:              f?.feature_stability?.n_unstable ?? null,
        signalWeights:          f?.signal_weights ?? null,
    };
}

// Merge the per-signal slices of features_snapshot into a synthetic batch-wide view.
//
// Signal-service writes a per-ticker minimal slice on every TradeSignal
// (GenerateSignals.ts: `analysisContext`) — composite_scores, factor_attributions,
// sectors, and laplacian_residuals are keyed by exactly the signal's own ticker;
// ticker_universe is deliberately empty to keep the persisted payload small. Reading
// only `batch.signals[0].features_snapshot` therefore exposes the first pick's row
// and pretends every other pick has no score — which silently breaks the factor
// dominance table, the cross-sectional dispersion histogram, and any sanity rule
// that counts entries in composite_scores.
//
// This helper unions the per-ticker maps across the batch so renderers see one row
// per pick in the cycle. Scalar/cycle-wide fields (regime_confidence, signal_weights,
// feature_stability, betti curves, persistence pairs, top_k, report_cadence,
// covariance_matrix) are identical across all signals in a single emit cycle, so
// we take them from the first signal. ticker_universe is reconstructed as the union
// of pick tickers — the strategy's full screening set is NOT in any slice, so this
// represents "tickers we have data for", not the upstream universe. Sanity rules
// that need a universe-level view (e.g. CONFIDENCE_SINGLETON_FALLBACK) should guard
// on `ticker_universe.length` and skip when the head is per-signal-slice shape.
export function mergeBatchFeatures(batch: CycleBatch): StrategyOutput | undefined {
    const first = batch.signals[0]?.features_snapshot;
    if (!first) return undefined;

    const composite_scores:    Record<string, number>                  = {};
    const factor_attributions: Record<string, Record<string, number>>  = {};
    const sectors:             Record<string, string>                  = {};
    const tickerSet:           Set<string>                             = new Set();
    let   laplacian_residuals: Record<string, number> | undefined      = undefined;

    for (const sig of batch.signals) {
        const f = sig.features_snapshot;
        if (!f) continue;
        for (const [t, v]    of Object.entries(f.composite_scores    ?? {})) composite_scores[t]    = v;
        for (const [t, row]  of Object.entries(f.factor_attributions ?? {})) factor_attributions[t] = row;
        for (const [t, sec]  of Object.entries(f.sectors             ?? {})) sectors[t]             = sec;
        for (const t         of f.ticker_universe                    ?? []) tickerSet.add(t);
        if (f.laplacian_residuals) {
            laplacian_residuals = laplacian_residuals ?? {};
            for (const [t, v] of Object.entries(f.laplacian_residuals)) laplacian_residuals[t] = v;
        }
    }

    return {
        ...first,
        composite_scores,
        factor_attributions,
        sectors,
        ticker_universe: tickerSet.size > 0 ? Array.from(tickerSet) : first.ticker_universe ?? [],
        ...(laplacian_residuals ? { laplacian_residuals } : {}),
    };
}
