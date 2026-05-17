import { z } from "zod";

// /api/admin/universe/overrides PUT
export const UniverseOverridesRequestSchema = z.object({
    adds: z.array(z.string()).optional(),
    removes: z.array(z.string()).optional(),
    userId: z.string().optional(),
});
export type UniverseOverridesRequest = z.infer<typeof UniverseOverridesRequestSchema>;

// /api/admin/market-data/backfill POST
export const BackfillRequestSchema = z.object({
    tickers: z.array(z.string()).optional(),
    days: z.number().int().min(1).max(60).optional(),
});
export type BackfillRequest = z.infer<typeof BackfillRequestSchema>;

// /api/admin/market-data/clear-cache POST
export const ClearCacheRequestSchema = z.object({
    interval: z.enum(["5m", "15m", "1h", "daily"]).optional(),
    beforeTimestamp: z.number().int().positive().optional(),
    dryRun: z.boolean().optional(),
});
export type ClearCacheRequest = z.infer<typeof ClearCacheRequestSchema>;

// /api/admin/market-data/config PUT
export const MarketConfigRequestSchema = z.object({
    barFrequency: z.enum(["daily", "intraday"]).nullable().optional(),
    pollIntervalMs: z.number().int().positive().nullable().optional(),
    signalOrderType: z.union([z.literal(0), z.literal(1), z.null()]).optional(),
    userId: z.string().optional(),
});
export type MarketConfigRequest = z.infer<typeof MarketConfigRequestSchema>;
