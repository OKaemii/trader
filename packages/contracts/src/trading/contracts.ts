import { z } from "zod";
import { defineContract } from "../contract.ts";
import {
    CashResponseSchema,
    PositionsResponseSchema,
    ExecuteOrderRequestSchema,
} from "./schemas.ts";

// Allowed callers for trading-service internal endpoints.
// portfolio-service polls cash + positions; signal-service hits cash for the
// AutoApprovalGate's pro-rate pass.
const PORTFOLIO   = ["portfolio-service"] as const;
const PORTFOLIO_OR_SIGNAL = ["portfolio-service", "signal-service"] as const;

export const getCashContract = defineContract({
    method: "GET",
    path: "/internal/trading/cash",
    callerScope: PORTFOLIO_OR_SIGNAL,
    responseSchema: CashResponseSchema,
});

export const getPositionsContract = defineContract({
    method: "GET",
    path: "/internal/trading/positions",
    callerScope: PORTFOLIO,
    responseSchema: PositionsResponseSchema,
});

// /api/admin/trading/execute — admin route, not an internal peer contract; the
// schemas are reused here so producer + ad-hoc tooling share one source of truth.
export const ExecuteOrderResponseSchema = z.union([
    z.object({ order: z.record(z.unknown()) }),
    z.object({ message: z.string() }),
]);
export const executeOrderContract = defineContract({
    method: "POST",
    path: "/api/admin/trading/execute",
    callerScope: [] as const,                       // user-fronted admin route, not peer-to-peer
    requestSchema: ExecuteOrderRequestSchema,
    responseSchema: ExecuteOrderResponseSchema,
});
