import { z } from "zod";
import { defineContract } from "../contract.ts";
import { InternalSectorsResponseSchema } from "./schemas.ts";

// Empty query — caller passes nothing; server reads `universeManager.activeTickers`.
// callerScope includes both strategy-engine (per-cycle hydration of `_strategy._sectors`)
// and notification-service (TelemetryBuilder universe-coverage roll-up).
export const internalSectorsContract = defineContract({
    method: "GET",
    path: "/internal/api/universe/sectors",
    callerScope: ["strategy-engine", "notification-service"] as const,
    requestSchema: z.void(),
    responseSchema: InternalSectorsResponseSchema,
});
