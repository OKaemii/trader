import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { Notification as NotificationContracts } from "@trader/contracts";
import type { NotificationDeps } from "../../../wiring.ts";

export function createPublicRouter(deps: NotificationDeps): Hono {
    const router = new Hono();

    // Push token registration endpoint (called by mobile app on login).
    router.post(
        "/push/register",
        zValidator("json", NotificationContracts.PushRegisterRequestSchema),
        async (c) => {
            const { token } = c.req.valid("json");
            await deps.redis.sAdd("push:tokens", token);
            return c.json({ registered: true });
        },
    );

    return router;
}
