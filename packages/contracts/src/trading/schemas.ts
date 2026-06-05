import { z } from "zod";
import { MoneySchema, CurrencySchema } from "../money.ts";

export const PositionSchema = z.object({
    ticker: z.string().min(1),
    quantity: z.number(),
    currentPrice: MoneySchema.optional(),
    currentValue: MoneySchema.optional(),
    averagePrice: MoneySchema.optional(),   // T212 cost basis per share — drives open (unrealised) P&L
});
export type Position = z.infer<typeof PositionSchema>;

export const CashResponseSchema = z.object({
    free: MoneySchema,
    total: MoneySchema,
});
export type CashResponse = z.infer<typeof CashResponseSchema>;

export const PositionsResponseSchema = z.object({
    positions: z.array(PositionSchema),
});
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

export const ExecuteOrderRequestSchema = z.object({
    signalId: z.string().min(1),
    ticker: z.string().min(1),
    action: z.enum(["BUY", "SELL"]),
    targetWeight: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    totalNAV: MoneySchema.optional(),
    currentPrice: MoneySchema.optional(),
    currentQuantity: z.number().int().nonnegative().optional(),
});
export type ExecuteOrderRequest = z.infer<typeof ExecuteOrderRequestSchema>;

export const SystemResetRequestSchema = z.object({
    confirm: z.string().optional(),
});
export type SystemResetRequest = z.infer<typeof SystemResetRequestSchema>;

// ── Swing trade plan ─────────────────────────────────────────────────────────
// Operator-set protective stop + profit target per ticker (Money, listing currency).
// PUT body: each field nullable to allow clearing just the stop or just the target.
export const TradePlanRequestSchema = z.object({
    stop: MoneySchema.nullable().optional(),
    target: MoneySchema.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    updatedBy: z.string().optional(),
});
export type TradePlanRequest = z.infer<typeof TradePlanRequestSchema>;

export const TradePlanSchema = z.object({
    ticker: z.string().min(1),
    stop: MoneySchema.optional(),
    target: MoneySchema.optional(),
    note: z.string().optional(),
    updatedBy: z.string(),
    updatedAt: z.number(),
});
export type TradePlan = z.infer<typeof TradePlanSchema>;

// A live position joined with its opening BUY (entry price + days held) and the operator's
// trade plan (stop/target), plus the derived R-multiple and stop distance. Money fields are
// in the position's listing currency; `rMultiple`/`stopDistancePct` are null when an input
// is missing (no entry, no stop, or entry === stop).
export const EnrichedPositionSchema = z.object({
    ticker: z.string(),
    quantity: z.number(),
    currency: CurrencySchema.nullable(),
    currentPrice: MoneySchema.nullable(),
    entryPrice: z.number().nullable(),
    entryAt: z.number().nullable(),
    daysHeld: z.number().nullable(),
    stop: MoneySchema.nullable(),
    target: MoneySchema.nullable(),
    rMultiple: z.number().nullable(),
    stopDistancePct: z.number().nullable(),
    note: z.string().nullable(),
});
export type EnrichedPosition = z.infer<typeof EnrichedPositionSchema>;
