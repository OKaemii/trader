import { z } from "zod";

// signal-service /internal/trading/signals/:id/executed (caller: trading-service)
export const ExecutedNotificationSchema = z.object({
    at: z.number().int().positive().optional(),
    quantity: z.number().nonnegative().optional(),
});
export type ExecutedNotification = z.infer<typeof ExecutedNotificationSchema>;

// signal-service /internal/trading/signals/:id/closed (caller: trading-service)
export const ClosedNotificationSchema = z.object({
    at: z.number().int().positive().optional(),
    exitPrice: z.number().positive(),
});
export type ClosedNotification = z.infer<typeof ClosedNotificationSchema>;

// signal-service /internal/trading/signals/:id/decrement-quantity (caller: trading-service)
export const DecrementQuantityRequestSchema = z.object({
    by: z.number().positive(),
});
export type DecrementQuantityRequest = z.infer<typeof DecrementQuantityRequestSchema>;

// signal-service /internal/queue/:id/failed (caller: trading-service)
export const QueueFailedRequestSchema = z.object({
    reason: z.number().int(),
    detail: z.string().optional(),
});
export type QueueFailedRequest = z.infer<typeof QueueFailedRequestSchema>;

// signal-service /api/admin/signals/auto-approve PUT
export const AutoApproveBodySchema = z.object({
    enabled: z.boolean(),
});
export type AutoApproveBody = z.infer<typeof AutoApproveBodySchema>;
