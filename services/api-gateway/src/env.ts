import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    PORT: z.coerce.number().int().positive().default(3000),

    JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
    CORS_ORIGINS: z.string().default("http://trader.local,http://localhost:3007"),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type GatewayEnv = z.infer<typeof EnvSchema>;
export const loadGatewayEnv = (): GatewayEnv => loadEnv(EnvSchema);
