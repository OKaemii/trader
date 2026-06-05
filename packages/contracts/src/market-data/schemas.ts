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
});
export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

// Long-range daily backfill (Yahoo-sourced, multi-year) — seeds the persisted
// `interval:'daily'` series that strategy lookbacks read. Distinct from BackfillRequest,
// whose `days` is bounded by the 60d 5m provider cap.
export const BackfillDailyRequestSchema = z.object({
    tickers: z.array(z.string()).optional(),
    years: z.number().int().min(1).max(30).optional(),
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
