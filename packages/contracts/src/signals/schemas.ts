import { z } from "zod";

// /internal/trading/signals/:id/executed
export const ExecutedNotificationSchema = z.object({
    at: z.number().int().positive().optional(),
    quantity: z.number().nonnegative().optional(),
});
export type ExecutedNotification = z.infer<typeof ExecutedNotificationSchema>;

export const ExecutedResponseSchema = z.object({
    id: z.string(),
    executedAt: z.number().int().positive(),
    executedQuantity: z.number().nonnegative().optional(),
});
export type ExecutedResponse = z.infer<typeof ExecutedResponseSchema>;

// /internal/trading/signals/:id/closed
export const ClosedNotificationSchema = z.object({
    at: z.number().int().positive().optional(),
    exitPrice: z.number().positive(),
});
export type ClosedNotification = z.infer<typeof ClosedNotificationSchema>;

export const ClosedResponseSchema = z.object({
    id: z.string(),
    closedAt: z.number().int().positive(),
    exitPrice: z.number().positive(),
});
export type ClosedResponse = z.infer<typeof ClosedResponseSchema>;

// /internal/trading/signals/:id/decrement-quantity
export const DecrementQuantityRequestSchema = z.object({
    by: z.number().positive(),
});
export type DecrementQuantityRequest = z.infer<typeof DecrementQuantityRequestSchema>;

export const DecrementQuantityResponseSchema = z.object({
    id: z.string(),
    decrementedBy: z.number().positive(),
});
export type DecrementQuantityResponse = z.infer<typeof DecrementQuantityResponseSchema>;

// /internal/trading/signals/open-buys/:ticker
export const OpenBuySchema = z.object({
    id: z.string(),
    executedQuantity: z.number().nonnegative().optional(),
    executedAt: z.number().int().positive().optional(),
});
export type OpenBuy = z.infer<typeof OpenBuySchema>;

export const OpenBuysResponseSchema = z.object({
    signals: z.array(OpenBuySchema),
});
export type OpenBuysResponse = z.infer<typeof OpenBuysResponseSchema>;

// /internal/queue/claim → returns { signal: ClaimedSignal | null }
export const ClaimedSignalSchema = z.object({
    id: z.string(),
    ticker: z.string(),
    action: z.enum(["BUY", "SELL", "HOLD"]),
    targetWeight: z.number(),
    confidence: z.number(),
    entryPrice: z.number().optional(),
    timestamp: z.number().int().positive(),
    attempts: z.number().int().nonnegative(),
});
export type ClaimedSignal = z.infer<typeof ClaimedSignalSchema>;

export const ClaimResponseSchema = z.object({
    signal: ClaimedSignalSchema.nullable(),
});
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

// /internal/queue/:id/failed
export const QueueFailedRequestSchema = z.object({
    reason: z.number().int(),
    detail: z.string().optional(),
});
export type QueueFailedRequest = z.infer<typeof QueueFailedRequestSchema>;

// /internal/queue/:id/requeue
export const QueueRequeueResponseSchema = z.object({
    id: z.string(),
    lifecycle: z.number().int(),
});
export type QueueRequeueResponse = z.infer<typeof QueueRequeueResponseSchema>;

// /internal/queue/sweep
export const QueueSweepRequestSchema = z.object({
    thresholdMs: z.number().int().positive().optional(),
});
export type QueueSweepRequest = z.infer<typeof QueueSweepRequestSchema>;

export const QueueSweepResponseSchema = z.object({
    reverted: z.number().int().nonnegative(),
});
export type QueueSweepResponse = z.infer<typeof QueueSweepResponseSchema>;

// /api/admin/signals/auto-approve
export const AutoApproveBodySchema = z.object({
    enabled: z.boolean(),
});
export type AutoApproveBody = z.infer<typeof AutoApproveBodySchema>;

// /internal/api/signals/telemetry-snapshot
//
// Pre-computed reporting telemetry derived from signal-service's authoritative
// stores — closed-signal realised P&L since `since`, in-flight lifecycle counts,
// open-position GBP MTM, and the latest decay metrics. Consumed by
// notification-service's TelemetryBuilder to populate the TelemetryBlock that
// grounds every quant-grade analysis email.
export const TelemetrySnapshotQuerySchema = z.object({
    since: z.coerce.number().int().nonnegative(),
});
export type TelemetrySnapshotQuery = z.infer<typeof TelemetrySnapshotQuerySchema>;

const PickSchema = z.object({
    ticker: z.string(),
    pnlPct: z.number(),
    pnlGbp: z.number(),
});

const DecayMetricsSchema = z.object({
    rollingSharpe30d: z.number(),
    hitRate30d: z.number(),
    turnoverRatio: z.number(),
    icTStat: z.number(),
    featureDriftKL: z.number(),
    computedAt: z.number().int().nonnegative(),
});

export const TelemetrySnapshotResponseSchema = z.object({
    since: z.number().int().nonnegative(),
    computedAt: z.number().int().positive(),
    realisedSinceLast: z.object({
        closedSignals: z.number().int().nonnegative(),
        pnlGbp: z.number(),
        bestPick: PickSchema.nullable(),
        worstPick: PickSchema.nullable(),
    }),
    lifecycleCounters: z.object({
        pending:   z.number().int().nonnegative(),
        approved:  z.number().int().nonnegative(),
        queued:    z.number().int().nonnegative(),
        executing: z.number().int().nonnegative(),
        executed:  z.number().int().nonnegative(),
        closed:    z.number().int().nonnegative(),
        failed:    z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
    }),
    openPositions: z.object({
        count: z.number().int().nonnegative(),
        mtmGbp: z.number(),
        fxDegraded: z.boolean(),
    }),
    risk: z.object({
        navGbp:        z.number(),
        hwmGbp:        z.number(),
        dailyLossPct:  z.number(),
        drawdownPct:   z.number(),
        circuit:       z.object({ open: z.boolean(), reason: z.string().nullable() }),
    }),
    decay: z.object({
        health: z.enum(['healthy', 'warning', 'degraded', 'suspended']),
        metrics: DecayMetricsSchema.nullable(),
    }),
});
export type TelemetrySnapshotResponse = z.infer<typeof TelemetrySnapshotResponseSchema>;

// Path params (single :id, single :ticker)
export const IdParamSchema     = z.object({ id:     z.string().min(1) });
export const TickerParamSchema = z.object({ ticker: z.string().min(1) });
