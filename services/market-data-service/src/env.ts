import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    PORT: z.coerce.number().int().positive().default(3002),

    BAR_FREQUENCY: z.enum(["daily", "intraday"]).default("daily"),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
    POLL_ANCHOR_OFFSET_MS: z.coerce.number().int().default(22 * 60 * 60_000),

    UNIVERSE_REFRESH_MS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60 * 1000),
    GAP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.20),
    TICKER_UNIVERSE: z.string().optional(),
    UNIVERSE_MAX_SIZE:   z.coerce.number().int().positive().default(150),
    UNIVERSE_INCLUDE_US:  z.string().default(""),
    UNIVERSE_INCLUDE_LSE: z.string().default(""),
    UNIVERSE_MIN_PRICE:   z.coerce.number().nonnegative().default(1.0),
    UNIVERSE_MIN_ADV:     z.coerce.number().nonnegative().default(2_000_000),

    // T212 credentials. Mirrors trading-service env semantics: when TRADING_MODE=Live the
    // T212_API_KEY / T212_API_KEY_ID pair is used; otherwise the demo pair. We always
    // accept all four (optional) so the service boots in either mode without sniffing
    // TRADING_MODE at the schema layer.
    TRADING_MODE: z.enum(["Paper", "Demo", "Live"]).default("Paper"),
    T212_API_KEY:         z.string().optional(),
    T212_API_KEY_ID:      z.string().optional(),
    T212_API_KEY_DEMO:    z.string().optional(),
    T212_API_KEY_ID_DEMO: z.string().optional(),

    // SIGNAL_ORDER_TYPE: surfaced in the admin /config response for portal symmetry.
    SIGNAL_ORDER_TYPE: z.string().default("Limit"),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type MarketDataEnv = z.infer<typeof EnvSchema>;
export const loadMarketDataEnv = (): MarketDataEnv => loadEnv(EnvSchema);
