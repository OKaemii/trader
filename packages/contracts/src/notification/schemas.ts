import { z } from "zod";

export const PushRegisterRequestSchema = z.object({
    token: z.string().min(1),
});
export type PushRegisterRequest = z.infer<typeof PushRegisterRequestSchema>;
