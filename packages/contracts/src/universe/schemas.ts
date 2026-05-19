import { z } from "zod";

// GET /internal/api/universe/sectors → ticker → GICS-sector map for the active universe.
// Owned by market-data-service. Caller: strategy-engine (hydrates `_strategy._sectors`
// once per process_loop iteration).
export const InternalSectorsResponseSchema = z.object({
    sectors:   z.record(z.string(), z.string()),
    // Unix ms — timestamp of the freshest row in the returned set. 0 when no row exists
    // for any universe ticker (cold-start state).
    fetchedAt: z.number().int().nonnegative(),
});
export type InternalSectorsResponse = z.infer<typeof InternalSectorsResponseSchema>;
