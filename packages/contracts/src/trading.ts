import { z } from "zod";
import { MoneySchema } from "./money.ts";

// /internal/trading/cash (callee: trading-service, callers: portfolio-service, signal-service)
export const CashResponseSchema = z.object({
    free: MoneySchema,
    total: MoneySchema,
});
export type CashResponse = z.infer<typeof CashResponseSchema>;

// /internal/trading/positions (callee: trading-service, caller: portfolio-service)
export const PositionSchema = z.object({
    ticker: z.string().min(1),
    quantity: z.number(),
    currentPrice: MoneySchema.optional(),
    currentValue: MoneySchema.optional(),
});
export const PositionsResponseSchema = z.object({
    positions: z.array(PositionSchema),
});
export type Position = z.infer<typeof PositionSchema>;
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>;

// /api/admin/trading/execute (admin manual order placement)
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
