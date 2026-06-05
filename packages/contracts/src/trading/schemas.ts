import { z } from "zod";
import { MoneySchema } from "../money.ts";

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
