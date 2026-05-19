import { defineContract } from "../contract.ts";
import {
    ExecutedNotificationSchema,
    ExecutedResponseSchema,
    ClosedNotificationSchema,
    ClosedResponseSchema,
    DecrementQuantityRequestSchema,
    DecrementQuantityResponseSchema,
    OpenBuysResponseSchema,
    ClaimResponseSchema,
    QueueFailedRequestSchema,
    QueueRequeueResponseSchema,
    QueueSweepRequestSchema,
    QueueSweepResponseSchema,
    TelemetrySnapshotQuerySchema,
    TelemetrySnapshotResponseSchema,
    IdParamSchema,
    TickerParamSchema,
} from "./schemas.ts";

const TRADING = ["trading-service"] as const;
const NOTIFICATION = ["notification-service"] as const;

export const markExecutedContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/:id/executed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: ExecutedNotificationSchema,
    responseSchema: ExecutedResponseSchema,
});

export const markClosedContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/:id/closed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: ClosedNotificationSchema,
    responseSchema: ClosedResponseSchema,
});

export const decrementQuantityContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/:id/decrement-quantity",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: DecrementQuantityRequestSchema,
    responseSchema: DecrementQuantityResponseSchema,
});

export const openBuysContract = defineContract({
    method: "GET",
    path: "/internal/api/signals/open-buys/:ticker",
    callerScope: TRADING,
    paramsSchema: TickerParamSchema,
    responseSchema: OpenBuysResponseSchema,
});

export const claimQueueContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/queue/claim",
    callerScope: TRADING,
    responseSchema: ClaimResponseSchema,
});

export const requeueContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/queue/:id/requeue",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    responseSchema: QueueRequeueResponseSchema,
});

export const failQueueContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/queue/:id/failed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: QueueFailedRequestSchema,
});

export const sweepQueueContract = defineContract({
    method: "POST",
    path: "/internal/api/signals/queue/sweep",
    callerScope: TRADING,
    requestSchema: QueueSweepRequestSchema,
    responseSchema: QueueSweepResponseSchema,
});

// Read-only reporting telemetry feed. notification-service's TelemetryBuilder pulls
// realised P&L since the last report window, open MTM, lifecycle counters, and decay
// state on every flush — assembled into the TelemetryBlock that grounds the
// strategy-aware quant-grade analysis email.
export const telemetrySnapshotContract = defineContract({
    method: "GET",
    path: "/internal/api/signals/telemetry-snapshot",
    callerScope: NOTIFICATION,
    querySchema: TelemetrySnapshotQuerySchema,
    responseSchema: TelemetrySnapshotResponseSchema,
});
