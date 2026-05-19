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
    const head: TradeSignalDTO | undefined = batch.signals[0];
    const f = head?.features_snapshot;
    return {
        snapshot:               f,
        regimeConfidence:       f?.regime_confidence       ?? null,
        positionSizeMultiplier: f?.position_size_multiplier ?? null,
        nStable:                f?.feature_stability ? Math.max(0, f.feature_stability.features.length - (f.feature_stability.n_unstable ?? 0)) : null,
        nUnstable:              f?.feature_stability?.n_unstable ?? null,
        signalWeights:          f?.signal_weights ?? null,
    };
}
