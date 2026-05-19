import { z } from "zod";
import { defineContract } from "../contract.ts";
import { InternalSectorsResponseSchema } from "./schemas.ts";

// Empty query — caller passes nothing; server reads `universeManager.activeTickers`.
export const internalSectorsContract = defineContract({
    method: "GET",
    path: "/internal/api/universe/sectors",
    callerScope: ["strategy-engine"] as const,
    requestSchema: z.void(),
    responseSchema: InternalSectorsResponseSchema,
});
