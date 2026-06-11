import { z } from "zod";

export const BarIntervalSchema = z.enum(["5m", "15m", "1h", "4h", "daily", "weekly"]);
export type BarInterval = z.infer<typeof BarIntervalSchema>;

export const RangeKeySchema = z.enum(["30d", "60d", "90d", "180d", "1y", "2y", "5y", "max"]);
export type RangeKey = z.infer<typeof RangeKeySchema>;

export const UniverseOverridesRequestSchema = z.object({
    adds: z.array(z.string()).optional(),
    removes: z.array(z.string()).optional(),
    userId: z.string().optional(),
});
export type UniverseOverridesRequest = z.infer<typeof UniverseOverridesRequestSchema>;

export const BackfillRequestSchema = z.object({
    tickers: z.array(z.string()).optional(),
    days: z.number().int().min(1).max(60).optional(),
    // Gap-aware by default (fetch only uncovered observation dates). `force: true` re-downloads
    // the whole window to repair a suspected-bad span — never the default. See §I.
    force: z.boolean().optional(),
});
export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

// Long-range daily backfill (Yahoo-sourced, multi-year) — seeds the persisted
// `interval:'daily'` series that strategy lookbacks read. Distinct from BackfillRequest,
// whose `days` is bounded by the 60d 5m provider cap.
export const BackfillDailyRequestSchema = z.object({
    tickers: z.array(z.string()).optional(),
    // Ceiling 40 (was 30) so the deep operator backfill can reach DAILY_BACKFILL_YEARS (35 → SPY's
    // 1993 inception). When omitted in deep mode the handler defaults years to DAILY_BACKFILL_YEARS;
    // otherwise to backfillDailyHistory's own default.
    years: z.number().int().min(1).max(40).optional(),
    // Target set: omitted/`active` → the active universe (existing behaviour); `curated-us` → the
    // curated-US subset only (the deep-backfill driver's scope — the names the PIT reads need). An
    // explicit `tickers` list always wins over `scope`.
    scope: z.enum(["active", "curated-us"]).optional(),
    // Operator-gated DEEP mode: defaults `years` to DAILY_BACKFILL_YEARS (35) when years is omitted,
    // so a single call seeds the full deep series. Still gap-aware (each missing date fetched once
    // then zero) — `deep` only changes the default depth, not the fetch strategy.
    deep: z.boolean().optional(),
    // Gap-aware by default (fetch only uncovered daily dates). `force: true` re-downloads the
    // whole multi-year span to repair a suspected-bad span — never the default. See §I.
    force: z.boolean().optional(),
});
export type BackfillDailyRequest = z.infer<typeof BackfillDailyRequestSchema>;

export const ClearCacheRequestSchema = z.object({
    interval: BarIntervalSchema.optional(),
    beforeTimestamp: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
});
export type ClearCacheRequest = z.infer<typeof ClearCacheRequestSchema>;

export const MarketConfigRequestSchema = z.object({
    barFrequency: z.enum(["daily", "intraday"]).nullable().optional(),
    pollIntervalMs: z.number().int().positive().nullable().optional(),
    signalOrderType: z.union([z.literal(0), z.literal(1), z.null()]).optional(),
    // Max active-universe size override (null = use the Helm/env default). Bounds enforced server-side.
    universeMaxSize: z.number().int().positive().nullable().optional(),
    userId: z.string().optional(),
});
export type MarketConfigRequest = z.infer<typeof MarketConfigRequestSchema>;

export const OHLCVBarSchema = z.object({
    ticker: z.string(),
    timestamp: z.number(),
    interval: BarIntervalSchema.optional(),
    open: z.number(),
    high: z.number(),
    low: z.number(),
    close: z.number(),
    volume: z.number(),
});
export type OHLCVBar = z.infer<typeof OHLCVBarSchema>;

export const InternalBarsRequestSchema = z.object({
    // Empty arrays are valid — caller signalling "no work to do" returns {bars: {}}.
    // Per-element non-empty is still enforced.
    tickers: z.array(z.string().min(1)),
    interval: BarIntervalSchema.optional(),
    range: RangeKeySchema.optional(),
    // Bi-temporal as-of cutoff in UTC ms. When set, returns the latest revision of
    // each observation_ts whose knowledge_ts <= asOf. Omitted = "as of now" (live read).
    asOf: z.number().int().positive().optional(),
});
export type InternalBarsRequest = z.infer<typeof InternalBarsRequestSchema>;

export const InternalBarsResponseSchema = z.object({
    interval: BarIntervalSchema,
    range: RangeKeySchema,
    bars: z.record(z.string(), z.array(OHLCVBarSchema)),
});
export type InternalBarsResponse = z.infer<typeof InternalBarsResponseSchema>;

// Single adjusted-close-at-or-before read for many tickers — the OOM-safe input the PIT
// market-cap enrichment (fundamentals-api) uses INSTEAD of pulling the whole `range='max'`
// series and picking the latest bar client-side. Returns one close (or null) per ticker, so the
// caller never holds a deep historical series in memory and the server never runs the chunk-fanning
// scan. `asOf` is the bi-temporal knowledge-time cutoff (omitted = live).
export const AdjustedCloseAtRequestSchema = z.object({
    tickers: z.array(z.string().min(1)),
    interval: BarIntervalSchema.optional(),
    asOf: z.number().int().positive().optional(),
});
export type AdjustedCloseAtRequest = z.infer<typeof AdjustedCloseAtRequestSchema>;

export const AdjustedCloseAtResponseSchema = z.object({
    interval: BarIntervalSchema,
    asOf: z.number().nullable(),
    // ticker → adjusted close at/<= asOf, or null when no bar qualifies (unseeded / nothing <= asOf).
    closes: z.record(z.string(), z.number().nullable()),
});
export type AdjustedCloseAtResponse = z.infer<typeof AdjustedCloseAtResponseSchema>;

// One swing-screener candidate: the technical signals it fired + a score (see screen.ts).
export const SwingScreenRowSchema = z.object({
    ticker: z.string(),
    close: z.number(),
    pctFrom52wHigh: z.number(),
    volSurge: z.number(),
    signals: z.array(z.string()),
    score: z.number(),
});
export type SwingScreenRow = z.infer<typeof SwingScreenRowSchema>;

// Next earnings + dividend dates for a ticker (UTC ms). null = unknown coverage (never fabricated).
export const EarningsEventSchema = z.object({
    ticker: z.string(),
    nextEarningsDate: z.number().nullable(),
    dividendDate: z.number().nullable(),
    source: z.string(),
});
export type EarningsEvent = z.infer<typeof EarningsEventSchema>;
