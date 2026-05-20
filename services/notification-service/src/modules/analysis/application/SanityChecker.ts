import type { TradeSignalDTO, StrategyOutput } from '@trader/shared-types';
import type { SanityFlag, TelemetryBlock } from './ReportContext.ts';

// SanityChecker — a small rule engine. Each rule is a pure
// `(signals, telemetry, head_features) => SanityFlag | null`.
// Rules never short-circuit each other; the checker runs them all and returns the
// non-null subset, sorted by severity (critical → warn → info). Renderers display
// the result above the LLM narrative so anomalies cannot be buried in prose.
//
// Why pure: rules are easy to unit-test (one fixture per rule) and easy to debug —
// every flag in production traces directly to a single source line.

export interface SanityCheckerConfig {
    // The signal-service min-positive-peers calibration constant. Below this count of
    // positive composite scores the divisor falls back to absolute 1.0 (instead of p95),
    // which means we surface a CONFIDENCE_SINGLETON_FALLBACK flag — the math switched
    // to its sparse-fallback path. Default mirrors GenerateSignals.MIN_POSITIVE_PEERS.
    minPositivePeers?: number;
    // Smallest "real" actionable threshold. Below this we consider the gate effectively
    // disabled, so a "zero BUYs" outcome is a calibration tell rather than market state.
    minActionableConfidenceFloor?: number;
    // Universe-size floor below which the strategy is "operating on the edge of its
    // statistical basis". Calibrated to roughly 1.5 × the typical strategy `min_universe_size`.
    universeFloor?: number;
    // Tolerance for the regime/multiplier identity multiplier = 0.25 + 0.75 * confidence.
    // Mismatches above this differential indicate the RegimeState pipeline got out of sync.
    regimeMultiplierTolerance?: number;
}

const DEFAULTS: Required<SanityCheckerConfig> = {
    minPositivePeers:             5,
    minActionableConfidenceFloor: 0.1,
    universeFloor:                30,
    regimeMultiplierTolerance:    0.05,
};

export interface SanityContext {
    signals:       TradeSignalDTO[];
    telemetry:     TelemetryBlock;
    headFeatures:  StrategyOutput | undefined;
    strategyId:    string;
}

type Rule = (ctx: SanityContext, cfg: Required<SanityCheckerConfig>) => SanityFlag | null;

// ── Baseline rules — run for every strategy ──────────────────────────────────

const ruleConfidenceSingletonFallback: Rule = (ctx, cfg) => {
    const composite = ctx.headFeatures?.composite_scores;
    if (!composite) return null;
    // The signal-service sparse-positive path is evaluated against the WHOLE universe
    // (ticker_universe.length entries in composite_scores). The head we see here is
    // built by mergeBatchFeatures over per-signal slices — composite_scores has one
    // entry per *pick*, not per universe ticker. For a typical small batch (1-5 picks)
    // `posCount < minPositivePeers` is mechanically true even when the upstream
    // universe was fully populated, so the rule false-positives on every cycle.
    //
    // We only evaluate when the head looks universe-shaped — meaning composite_scores
    // is materially larger than the batch's signal count. Otherwise the signal-service
    // fallback path can't be diagnosed from this side and we silently skip.
    const universeShaped = Object.keys(composite).length > ctx.signals.length;
    if (!universeShaped) return null;
    const posCount = Object.values(composite).filter((v) => v > 0).length;
    if (posCount >= cfg.minPositivePeers) return null;
    // The fix-up-the-math rule. factor_rank cares the most (its picks are cross-sectional
    // rankings); other strategies degrade more gracefully so we drop to warn.
    const severity: SanityFlag['severity'] = ctx.strategyId.startsWith('factor_rank') ? 'critical' : 'warn';
    return {
        severity,
        code: 'CONFIDENCE_SINGLETON_FALLBACK',
        message: `Only ${posCount} positive composite score(s) this cycle — confidence math fell back to an absolute divisor (sparse-positive path).`,
        hint: 'Confidence values are bounded but not normalised across a meaningful peer set. Treat conviction with skepticism this cycle.',
        evidence: { posCount, minPositivePeers: cfg.minPositivePeers },
    };
};

const ruleRegimeColdStart: Rule = (ctx) => {
    if (!ctx.telemetry.regime.coldStart) return null;
    return {
        severity: 'warn',
        code: 'REGIME_COLD_START',
        message: 'Regime confidence sits at the 0.5 sentinel — the RegimeEngine has not accumulated enough history yet.',
        hint: 'Position-sizing is using the default centre value. Expect this to lift once the engine sees more bars.',
        evidence: { regimeConfidence: ctx.telemetry.regime.confidence },
    };
};

const ruleRegimeMultiplierMismatch: Rule = (ctx, cfg) => {
    const conf = ctx.telemetry.regime.confidence;
    const mult = ctx.telemetry.regime.positionSizeMultiplier;
    if (conf === null || mult === null) return null;
    // Engine contract: multiplier = 0.25 + 0.75 * confidence. Significant divergence here
    // means RegimeState got out of sync with the multiplier it advertises — a math contradiction.
    const expected = 0.25 + 0.75 * conf;
    const drift = Math.abs(mult - expected);
    if (drift <= cfg.regimeMultiplierTolerance) return null;
    return {
        severity: 'critical',
        code: 'REGIME_MULTIPLIER_MISMATCH',
        message: `Position-size multiplier (${mult.toFixed(3)}) differs from regime-implied ${expected.toFixed(3)} by ${drift.toFixed(3)}.`,
        hint: 'RegimeState and the size multiplier path are out of sync — likely a regression in regime_engine.update().',
        evidence: { multiplier: mult, regimeConfidence: conf, expected, drift },
    };
};

const ruleUniverseAtFloor: Rule = (ctx, cfg) => {
    const { readyCount, activeCount } = ctx.telemetry.universe;
    if (readyCount >= cfg.universeFloor) return null;
    return {
        severity: 'warn',
        code: 'UNIVERSE_AT_FLOOR',
        message: `Only ${readyCount} of ${activeCount} universe instruments are ready this cycle (floor=${cfg.universeFloor}).`,
        hint: 'Cross-sectional statistics are noisy at this universe size. Increase universeMaxSize or wait for warm-up to complete.',
        evidence: { readyCount, activeCount, floor: cfg.universeFloor },
    };
};

const ruleStabilityDegraded: Rule = (ctx) => {
    const fs = ctx.headFeatures?.feature_stability;
    if (!fs || fs.n_unstable <= 1) return null;
    return {
        severity: 'warn',
        code: 'STABILITY_DEGRADED',
        message: `${fs.n_unstable} features failed stationarity this cycle (stability_score=${fs.stability_score.toFixed(3)}).`,
        hint: 'Factor inputs are drifting. Consider tightening the feature filter or pausing the strategy until stability recovers.',
        evidence: { n_unstable: fs.n_unstable, stability_score: fs.stability_score },
    };
};

const ruleCircuitBreakerOpen: Rule = (ctx) => {
    const cb = ctx.telemetry.circuitBreaker;
    if (!cb.open) return null;
    return {
        severity: 'critical',
        code: 'CIRCUIT_BREAKER_OPEN',
        message: `RiskEngine circuit breaker is OPEN: ${cb.reason ?? '(no reason recorded)'}.`,
        hint: 'Order placement is blocked until reset. Investigate the trip cause before clearing from /admin/api/signals/risk/circuit-breaker/reset.',
        evidence: { reason: cb.reason },
    };
};

const ruleDecayDegraded: Rule = (ctx) => {
    const health = ctx.telemetry.decay.health;
    if (health === 'healthy') return null;
    const severity: SanityFlag['severity'] = health === 'suspended' ? 'critical'
        : health === 'degraded' ? 'critical'
        : 'warn';
    return {
        severity,
        code: 'DECAY_DEGRADED',
        message: `Strategy decay state is ${health} (multiplier=${ctx.telemetry.decay.multiplier.toFixed(2)}).`,
        hint: health === 'suspended'
            ? 'Strategy is gated. New signals will not auto-approve.'
            : 'Inspect StrategyDecayMonitor metrics — one of Sharpe / hit-rate / turnover / IC-tstat / drift exceeded its threshold.',
        evidence: { health, ic30d: ctx.telemetry.decay.ic_30d },
    };
};

const ruleZeroBuysActionableLow: Rule = (ctx, cfg) => {
    const { buys } = ctx.telemetry.signals;
    if (buys > 0) return null;
    // We don't read MIN_ACTIONABLE_CONFIDENCE here — the caller can override the floor.
    // Default 0.1 is the "the gate is functionally off" line: zero BUYs below that means
    // the strategy literally produced nothing, not that the gate filtered them out.
    if (cfg.minActionableConfidenceFloor >= 0.1) return null;
    return {
        severity: 'info',
        code: 'ZERO_BUYS_BUT_ACTIONABLE_THRESHOLD_LOW',
        message: `No BUY signals this cycle, and the actionable-confidence gate is set very low (<${cfg.minActionableConfidenceFloor}).`,
        hint: 'The absence is structural, not a filter artifact. Consider whether the strategy is calibrated to the current regime.',
        evidence: { buys, minActionableConfidenceFloor: cfg.minActionableConfidenceFloor },
    };
};

const ruleMissingFeatureContext: Rule = (ctx) => {
    if (ctx.headFeatures) return null;
    return {
        severity: 'info',
        code: 'MISSING_FEATURE_CONTEXT',
        message: 'No features_snapshot on the head signal — this batch predates the persistence fix or the cycle did not attach one.',
        hint: 'Strategy-specific renderers fall back to telemetry-only output. Re-run the cycle after pulling the fix to restore strategy-aware reporting.',
    };
};

const BASELINE_RULES: Rule[] = [
    ruleConfidenceSingletonFallback,
    ruleRegimeColdStart,
    ruleRegimeMultiplierMismatch,
    ruleUniverseAtFloor,
    ruleStabilityDegraded,
    ruleCircuitBreakerOpen,
    ruleDecayDegraded,
    ruleZeroBuysActionableLow,
    ruleMissingFeatureContext,
];

const SEVERITY_ORDER: Record<SanityFlag['severity'], number> = { critical: 0, warn: 1, info: 2 };

export class SanityChecker {
    private readonly cfg: Required<SanityCheckerConfig>;

    constructor(cfg: SanityCheckerConfig = {}) {
        this.cfg = { ...DEFAULTS, ...cfg };
    }

    check(ctx: SanityContext, extraRules: Rule[] = []): SanityFlag[] {
        const out: SanityFlag[] = [];
        for (const rule of [...BASELINE_RULES, ...extraRules]) {
            const flag = rule(ctx, this.cfg);
            if (flag) out.push(flag);
        }
        return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    }
}

// Exported for downstream strategy renderers to compose their own additional rule sets
// with the baseline. See e.g. FactorRankRenderer's FACTOR_DEGENERATE rule.
export type { Rule };
