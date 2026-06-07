import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    PORT: z.coerce.number().int().positive().default(3003),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    MONGODB_DB:  z.string().default("trader"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    TRADING_SERVICE_URL: z.string().url().default("http://trading-service:3005"),

    // Strategy knobs read by GenerateSignals + LongOnlyOptimiser.
    MIN_ACTIONABLE_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.30),
    VOL_TARGET:                z.coerce.number().min(0).max(1).default(0.10),
    // Confidence-math calibration. MIN_POSITIVE_PEERS = below this, the cross-sectional
    // p95 collapses to a singleton and the divisor falls back to a fixed 1.0 (keeps
    // confidence honest on sparse universes). MIN_SCORE_EPSILON = |score| floor below
    // which confidence is forced to 0 regardless of the cross-section.
    MIN_POSITIVE_PEERS:        z.coerce.number().int().min(1).default(5),
    MIN_SCORE_EPSILON:         z.coerce.number().min(0).default(0.1),

    // Held-position target for the market-summary concentration read (HHI target = 1/topK). Matches
    // the FACTOR_RANK_TOP_K Helm knob — the default strategy's held-set size. Display-only here
    // (the optimiser still owns the live top-K in GenerateSignals).
    FACTOR_RANK_TOP_K:         z.coerce.number().int().positive().default(20),

    // Per-pod consumer name on Redis-stream subscriber.
    POD_NAME: z.string().default("local"),

    // Comma-separated list of strategy-output streams to multiplex. Each entry spawns
    // its own subscriber with consumer group `signal-service:{stream}`. Defaults to the
    // legacy single stream so a chart without WP2's per-worker outputs keeps working.
    // WP2 helm sets this to e.g. "signals:strategy,signals:strategy:5m:factor_rank_v1,signals:strategy:daily:factor_rank_v1"
    // — keep the legacy entry during cutover so in-flight signals on the old stream are
    // drained, then drop it once strategy-engine has fully migrated.
    STRATEGY_INPUT_STREAMS: z.string().default("signals:strategy"),

    // AutoApprovalGate sweeper interval. The gate's per-cycle process() is fire-and-forget
    // and per-signal exceptions are caught + dropped (e.g. Mongo NotWritablePrimary during a
    // primary failover), so without the sweeper any signal that hit such an error stays at
    // lifecycle=Pending forever. 60s gives a stuck signal at most one minute to recover —
    // shorter than the polling cadence on the portal page, so the operator never sees a
    // permanently-stuck row when auto-approve is on.
    AUTO_APPROVE_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

    // AlertWatcher cadence — how often enabled price-alert rules are evaluated against the latest
    // bar. Swing alerts are EOD-grained, so hourly is ample (per-rule cooldownH prevents spam).
    ALERT_WATCH_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type SignalEnv = z.infer<typeof EnvSchema>;
export const loadSignalEnv = (): SignalEnv => loadEnv(EnvSchema);
