import { z } from "zod";

export const SystemResetRequestSchema = z.object({
    confirm: z.literal("RESET"),
});
export type SystemResetRequest = z.infer<typeof SystemResetRequestSchema>;
