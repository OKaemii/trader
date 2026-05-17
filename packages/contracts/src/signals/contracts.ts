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
    IdParamSchema,
    TickerParamSchema,
} from "./schemas.ts";

const TRADING = ["trading-service"] as const;

export const markExecutedContract = defineContract({
    method: "POST",
    path: "/internal/trading/signals/:id/executed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: ExecutedNotificationSchema,
    responseSchema: ExecutedResponseSchema,
});

export const markClosedContract = defineContract({
    method: "POST",
    path: "/internal/trading/signals/:id/closed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: ClosedNotificationSchema,
    responseSchema: ClosedResponseSchema,
});

export const decrementQuantityContract = defineContract({
    method: "POST",
    path: "/internal/trading/signals/:id/decrement-quantity",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: DecrementQuantityRequestSchema,
    responseSchema: DecrementQuantityResponseSchema,
});

export const openBuysContract = defineContract({
    method: "GET",
    path: "/internal/trading/signals/open-buys/:ticker",
    callerScope: TRADING,
    paramsSchema: TickerParamSchema,
    responseSchema: OpenBuysResponseSchema,
});

export const claimQueueContract = defineContract({
    method: "POST",
    path: "/internal/queue/claim",
    callerScope: TRADING,
    responseSchema: ClaimResponseSchema,
});

export const requeueContract = defineContract({
    method: "POST",
    path: "/internal/queue/:id/requeue",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    responseSchema: QueueRequeueResponseSchema,
});

export const failQueueContract = defineContract({
    method: "POST",
    path: "/internal/queue/:id/failed",
    callerScope: TRADING,
    paramsSchema: IdParamSchema,
    requestSchema: QueueFailedRequestSchema,
});

export const sweepQueueContract = defineContract({
    method: "POST",
    path: "/internal/queue/sweep",
    callerScope: TRADING,
    requestSchema: QueueSweepRequestSchema,
    responseSchema: QueueSweepResponseSchema,
});
