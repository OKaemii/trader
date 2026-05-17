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

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type MarketDataEnv = z.infer<typeof EnvSchema>;
export const loadMarketDataEnv = (): MarketDataEnv => loadEnv(EnvSchema);
