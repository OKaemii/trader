import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    PORT: z.coerce.number().int().positive().default(3004),

    POD_NAME: z.string().default("local"),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    // Peer-service base URLs for the analysis-email telemetry path. signal-service hosts
    // the telemetry-snapshot endpoint (realised P&L, lifecycle counters, decay state);
    // market-data-service hosts the sectors map used for universe-coverage telemetry.
    SIGNAL_SERVICE_URL:      z.string().url().default("http://signal-service:3003"),
    MARKET_DATA_SERVICE_URL: z.string().url().default("http://market-data-service:3001"),

    PORTAL_BASE_URL: z.string().url().default("http://trader.local"),

    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM:     z.string().email().optional(),
    EMAIL_TO:       z.string().email().optional(),

    // DeepSeek API key. When set, notification-service runs a per-cycle batcher that
    // sends ONE enriched analysis email per strategy cycle (covering all picks together
    // with company profiles + sector-relative reasoning). Empty disables the analysis
    // path; per-signal quick emails keep firing.
    DEEPSEEK_API_KEY: z.string().optional(),

    // Operator override for intraday strategies' reporting cadence. When an intraday
    // strategy advertises `report_cadence='hourly'` (the default), this env can dial
    // it DOWN to `four_hourly` or `eod` for less email volume. `per_cycle` is rejected
    // for intraday strategies — would reintroduce the 12-emails-per-hour problem the
    // cadence design was created to fix. Daily strategies (declared `per_cycle`) ignore
    // this override entirely.
    REPORT_INTRADAY_CADENCE: z.enum(['hourly', 'four_hourly', 'eod']).default('hourly'),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type NotificationEnv = z.infer<typeof EnvSchema>;
export const loadNotificationEnv = (): NotificationEnv => loadEnv(EnvSchema);
