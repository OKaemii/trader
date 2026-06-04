import { z } from "zod";
import { loadEnv } from "@trader/core";

// k8s Secrets inject a present-but-blank key as "" (empty string), not undefined. zod's
// .optional() treats only undefined as absent, so an empty optional URL/email reaches
// .url()/.email(), fails validation, and crashes the service on boot (CrashLoopBackOff —
// what stalled the deploy). Coerce blank → undefined so a blank secret means "feature
// disabled", as documented (empty ALERT_WEBHOOK_URL disables the webhook channel; an empty
// ALERT_EMAIL_TO then falls back to EMAIL_TO). A genuinely malformed value still rejects.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalUrl   = z.preprocess(blankToUndefined, z.string().url().optional());
const optionalEmail = z.preprocess(blankToUndefined, z.string().email().optional());

export const EnvSchema = z.object({
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
    MARKET_DATA_SERVICE_URL: z.string().url().default("http://market-data-service:3002"),

    PORTAL_BASE_URL: z.string().url().default("http://trader.local"),

    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM:     optionalEmail,
    EMAIL_TO:       optionalEmail,

    // Operational alerting (G4). ALERT_WEBHOOK_URL: a generic incoming-webhook URL (Slack/Discord/
    // custom) that receives `critical` alerts. Empty disables the webhook channel. ALERT_EMAIL_TO:
    // recipient for `warning`+`critical` alert emails; falls back to EMAIL_TO when unset.
    ALERT_WEBHOOK_URL: optionalUrl,
    ALERT_EMAIL_TO:    optionalEmail,

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

    OTLP_ENDPOINT: optionalUrl,
});

export type NotificationEnv = z.infer<typeof EnvSchema>;
export const loadNotificationEnv = (): NotificationEnv => loadEnv(EnvSchema);
