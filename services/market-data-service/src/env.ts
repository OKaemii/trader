import { z } from "zod";
import { loadEnv } from "@trader/core";

const EnvSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

    PORT: z.coerce.number().int().positive().default(3002),

    BAR_FREQUENCY: z.enum(["daily", "intraday"]).default("daily"),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
    POLL_ANCHOR_OFFSET_MS: z.coerce.number().int().default(22 * 60 * 60_000),
    // Bid/ask quote poll cadence (Yahoo v7/quote side-channel). Default 1h, matching bars.
    QUOTE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60_000),

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

    // ── Market-data provider ──────────────────────────────────────────────────
    // Active upstream for OHLCV bars + liquidity. Defaults to TwelveData; `yahoo` keeps
    // the legacy free Yahoo Finance path as a fallback (no API key needed). FX rates and
    // sector classification stay on Yahoo regardless — separate, free, low-volume calls.
    MARKET_DATA_PROVIDER: z.enum(["twelvedata", "yahoo"]).default("twelvedata"),
    // TwelveData free Basic plan: 8 credits/min, 800/day, 1 credit per symbol. The key is
    // injected from trader-secrets (TWELVEDATA_API_KEY); bump the credit knobs to match a
    // paid plan. Optional so the service still boots (provider returns no bars) without it.
    TWELVEDATA_API_KEY:            z.string().optional(),
    TWELVEDATA_CREDITS_PER_MIN:    z.coerce.number().int().positive().default(8),
    TWELVEDATA_DAILY_CREDIT_LIMIT: z.coerce.number().int().positive().default(800),

    // ── EODHD (daily/EOD + market scanner) ────────────────────────────────────
    // EODHD is the single universe SOURCE (screener) + the long-range daily feed; intraday
    // stays on TwelveData. Key from trader-secrets (EODHD_API_KEY <- tfvars eodhd_api_key).
    // Call budgets are conservative ceilings under the 100k/month plan (with headroom).
    EODHD_API_KEY:          z.string().optional(),
    EODHD_CALLS_PER_MIN:    z.coerce.number().int().positive().default(1000),
    EODHD_DAILY_CALL_LIMIT: z.coerce.number().int().positive().default(90_000),
    // Universe candidate source. 'curated' = UNIVERSE_INCLUDE_* lists; 'eodhd_scan' = the EODHD
    // market-cap screener (>= MIN_MARKET_CAP_GBP, US+LSE). One active universe either way.
    UNIVERSE_SOURCE:    z.enum(["curated", "eodhd_scan"]).default("curated"),
    MIN_MARKET_CAP_GBP: z.coerce.number().nonnegative().default(5_000_000_000),
    // Long-range daily history source (decoupled from the metered intraday provider).
    DAILY_HISTORY_PROVIDER: z.enum(["yahoo", "eodhd"]).default("yahoo"),
    // Fundamentals (QMJ) source. 'yahoo' (free quoteSummary, default) or 'eodhd' (paid add-on).
    FUNDAMENTALS_PROVIDER:  z.enum(["yahoo", "eodhd"]).default("yahoo"),
    // Fundamentals refresh pacing. The QMJ refresh walks the universe one name at a time; a
    // burst trips Yahoo's per-IP rate limiter (which arms a multi-minute session cooldown that
    // zeroes the whole run). These knobs keep the background refresher gentle + resumable.
    //   _SPACING_MS — sleep between successive per-ticker provider calls (gentleness).
    //   _IDLE_MS    — sleep once coverage is complete (re-checks staleness ~twice/day).
    //   _RETRY_MS   — sleep after a no-progress pass (provider throttled); > the 15m cooldown.
    //   _PROGRESS_MS— sleep after a partial pass, to keep accreting without hammering.
    FUNDAMENTALS_REQUEST_SPACING_MS: z.coerce.number().int().nonnegative().default(500),
    FUNDAMENTALS_REFRESH_IDLE_MS:     z.coerce.number().int().positive().default(12 * 60 * 60_000),
    FUNDAMENTALS_REFRESH_RETRY_MS:    z.coerce.number().int().positive().default(20 * 60_000),
    FUNDAMENTALS_REFRESH_PROGRESS_MS: z.coerce.number().int().positive().default(2 * 60_000),

    MONGODB_URL: z.string().url().default("mongodb://mongodb:27017"),
    REDIS_URL:   z.string().url().default("redis://redis:6379"),

    OTLP_ENDPOINT: z.string().url().optional(),
});

export type MarketDataEnv = z.infer<typeof EnvSchema>;
export const loadMarketDataEnv = (): MarketDataEnv => loadEnv(EnvSchema);
