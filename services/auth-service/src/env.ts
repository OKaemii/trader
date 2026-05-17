import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    PORT: z.coerce.number().int().positive().default(3001),

    JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 chars"),
    JWT_ACCESS_TTL_SEC:  z.coerce.number().int().positive().default(900),       // 15 min
    JWT_REFRESH_TTL_SEC: z.coerce.number().int().positive().default(604_800),   // 7 days

    SEED_ADMIN_EMAIL:    z.string().email().optional(),
    SEED_ADMIN_PASSWORD: z.string().min(8).optional(),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    OTLP_ENDPOINT: z.string().url().optional(),
}).superRefine((env, ctx) => {
    if (env.SEED_ADMIN_EMAIL && !env.SEED_ADMIN_PASSWORD) {
        ctx.addIssue({ code: "custom", path: ["SEED_ADMIN_PASSWORD"], message: "required when SEED_ADMIN_EMAIL is set" });
    }
});

export type AuthEnv = z.infer<typeof EnvSchema>;
export const loadAuthEnv = (): AuthEnv => loadEnv(EnvSchema);
