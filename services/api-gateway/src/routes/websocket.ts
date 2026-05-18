import type { Hono } from "hono";
import { verifyAccessToken } from "@trader/shared-auth";
import { getRedisClient, subscribe } from "@trader/shared-redis";

/** Registers /ws/topology on `app` using the bound upgradeWebSocket from createNodeWebSocket. */
export function registerWebSockets(
    app: Hono,
    upgradeWebSocket: ReturnType<typeof import("@hono/node-ws").createNodeWebSocket>["upgradeWebSocket"],
): void {
    app.get("/ws/topology", upgradeWebSocket(async (c) => {
        const token = c.req.query("token");
        if (!token) {
            return { onOpen(_, ws) { ws.close(1008, "Unauthorized"); } };
        }
        try {
            await verifyAccessToken(token);
        } catch {
            return { onOpen(_, ws) { ws.close(1008, "Invalid token"); } };
        }
        let cleanup: (() => void) | undefined;
        return {
            async onOpen(_, ws) {
                const redis = await getRedisClient();
                cleanup = await subscribe(redis, "strategy:dashboard", (p) => ws.send(JSON.stringify(p)));
            },
            onClose() { cleanup?.(); },
        };
    }));
}
