import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    PORT: z.coerce.number().int().positive().default(3004),

    POD_NAME: z.string().default("local"),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM:     z.string().email().optional(),
    EMAIL_TO:       z.string().email().optional(),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type NotificationEnv = z.infer<typeof EnvSchema>;
export const loadNotificationEnv = (): NotificationEnv => loadEnv(EnvSchema);
