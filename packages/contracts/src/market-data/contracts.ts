import { defineContract } from "../contract.ts";
import {
    InternalBarsRequestSchema,
    InternalBarsResponseSchema,
} from "./schemas.ts";

export const internalBarsContract = defineContract({
    method: "POST",
    path: "/internal/api/market-data/bars",
    callerScope: ["strategy-engine"] as const,
    requestSchema: InternalBarsRequestSchema,
    responseSchema: InternalBarsResponseSchema,
});
