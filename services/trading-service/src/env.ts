import { z } from "zod";
import { loadEnv } from "@trader/core";
import { TradingMode } from "./modules/orders/domain/Order.ts";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    PORT: z.coerce.number().int().positive().default(3005),

    TRADING_MODE: z.enum(["Paper", "Demo", "Live"]).default("Paper").transform((v) => TradingMode[v]),

    T212_API_KEY:         z.string().optional(),
    T212_API_KEY_ID:      z.string().optional(),
    T212_API_KEY_DEMO:    z.string().optional(),
    T212_API_KEY_ID_DEMO: z.string().optional(),

    FILL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
    ORDER_MIN_INTERVAL_MS: z.coerce.number().int().positive().default(1_100),
    ORDER_MAX_ATTEMPTS:    z.coerce.number().int().positive().default(5),
    QUEUE_TTL_MS:          z.coerce.number().int().positive().default(3_600_000),
    // MARKET orders stop retrying after this window (then fail QueueExpired); LIMIT orders use
    // QUEUE_TTL_MS. A stale market order is no longer the same trade.
    MARKET_RETRY_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
    ACCOUNT_CACHE_TTL_MS:  z.coerce.number().int().positive().default(30_000),
    PRICE_DRIFT_TOLERANCE: z.coerce.number().nonnegative().default(0.01),
    // Drift gate mid-quote freshness window. 0 → always last-close (pre-quote behaviour).
    DRIFT_QUOTE_FRESHNESS_MS: z.coerce.number().int().nonnegative().default(900_000),

    SIGNAL_SERVICE_URL: z.string().url().default("http://signal-service:3003"),
    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    // SIGNAL_ORDER_TYPE: the default order shape signal-driven orders use (operator can
    // override at runtime via the portal). Helm sets it as the enum member name; we also
    // accept the integer for parameterised setups. Resolved to OrderType in wiring.ts.
    SIGNAL_ORDER_TYPE: z.string().default("Limit"),

    // Reconciliation. AUTO_HEAL defaults OFF (observe-only: findings + NAV recorded, no
    // mutations) — flip on once findings are trusted. Thresholds bound what auto-heal touches.
    RECONCILE_AUTO_HEAL:             z.coerce.boolean().default(false),
    RECONCILE_POSITION_AUTO_SHARES:  z.coerce.number().nonnegative().default(1),
    RECONCILE_POSITION_ALERT_SHARES: z.coerce.number().nonnegative().default(10),
    RECONCILE_CASH_ALERT_GBP:        z.coerce.number().nonnegative().default(10),
    RECONCILE_MAX_HISTORY_PAGES:     z.coerce.number().int().positive().default(50),
    // In-process reconcile cadence (demo/live). 0 disables the loop (manual endpoint still works).
    RECONCILE_INTERVAL_MS:           z.coerce.number().int().nonnegative().default(4 * 60 * 60 * 1000),

    OTLP_ENDPOINT: z.string().url().optional(),
}).superRefine((env, ctx) => {
    if (env.TRADING_MODE !== TradingMode.Paper) {
        const live = env.TRADING_MODE === TradingMode.Live;
        const key   = live ? env.T212_API_KEY    : env.T212_API_KEY_DEMO;
        const keyId = live ? env.T212_API_KEY_ID : env.T212_API_KEY_ID_DEMO;
        if (!key || !keyId) {
            ctx.addIssue({
                code: "custom",
                path: ["T212_API_KEY"],
                message: `${live ? "T212_API_KEY/T212_API_KEY_ID" : "T212_API_KEY_DEMO/T212_API_KEY_ID_DEMO"} required when TRADING_MODE=${TradingMode[env.TRADING_MODE]}`,
            });
        }
    }
});

export type TradingEnv = z.infer<typeof EnvSchema>;
export const loadTradingEnv = (): TradingEnv => loadEnv(EnvSchema);
