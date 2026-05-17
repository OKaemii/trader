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

    // Per-pod consumer name on Redis-stream subscriber.
    POD_NAME: z.string().default("local"),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type SignalEnv = z.infer<typeof EnvSchema>;
export const loadSignalEnv = (): SignalEnv => loadEnv(EnvSchema);
