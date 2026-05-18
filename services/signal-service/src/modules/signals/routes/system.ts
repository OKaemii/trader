// Service-level admin actions that aren't part of the signal lifecycle but live here
// because signal-service is already wired to mongo + redis + strategy pubsub:
//   - /ws/api/signals/topology       — WebSocket fan-out of `strategy:dashboard` redis pubsub
//   - /admin/api/signals/system-reset — wipes all derived state (signals, orders, bars, …)
//                                        from mongo + redis to start a clean trading run

import type { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Logger } from "@trader/core";
import { parseAdminHeaders } from "@trader/shared-auth/middleware";
import { verifyTokenForAudience } from "@trader/shared-auth";
import { Gateway as GatewayContracts } from "@trader/contracts";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient, subscribe } from "@trader/shared-redis";

/**
 * /ws/api/signals/topology — WebSocket subscription to the `strategy:dashboard` redis
 * pubsub channel. Authentication is via `?token=<userJwt>` query param (browsers can't
 * set custom headers on WS upgrade); we verify the same JWT a normal /api/signals/*
 * request would carry, accepting `user` or `admin` audiences.
 */
export function registerTopologyWebSocket(
    app: Hono,
    upgradeWebSocket: ReturnType<typeof import("@hono/node-ws").createNodeWebSocket>["upgradeWebSocket"],
): void {
    app.get("/ws/api/signals/topology", upgradeWebSocket(async (c) => {
        const token = c.req.query("token");
        if (!token) {
            return { onOpen(_, ws) { ws.close(1008, "Unauthorized"); } };
        }
        try {
            await verifyTokenForAudience(token, ["user", "admin"]);
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

/**
 * /admin/api/signals/system-reset — wipes trading history + strategy state to start
 * fresh from today. Drops every derived collection from mongo, trims the redis streams,
 * and deletes runtime keys under known prefixes. Preserves users + portal overrides.
 * Real T212 broker state is NOT touched.
 */
export function registerSystemReset(app: Hono, logger: Logger): void {
    app.post(
        "/admin/api/signals/system-reset",
        parseAdminHeaders,
        zValidator("json", GatewayContracts.SystemResetRequestSchema, (result, c) => {
            if (!result.success) {
                return c.json({ error: 'confirmation phrase mismatch (expected "RESET")' }, 400);
            }
        }),
        async (c) => {
            const result: Record<string, number | string> = {};
            try {
                const db = await getMongoDb();
                const wipe = [
                    "signals", "ohlcv_bars", "orders", "positions", "backtest_results",
                    "instrument_registry", "topology_snapshots", "strategy_health_log",
                    "model_versions", "feature_importance_log", "risk_state", "risk_rejections",
                    "bad_ticks",
                ];
                for (const name of wipe) {
                    const r = await db.collection(name).deleteMany({});
                    result[`mongo.${name}`] = r.deletedCount ?? 0;
                }

                const redis = await getRedisClient();
                try { await redis.sendCommand(["XTRIM", "market:raw",       "MAXLEN", "0"]); result["redis.stream.market:raw"] = "trimmed"; }
                catch (e) { result["redis.stream.market:raw"] = `error: ${(e as Error).message}`; }
                try { await redis.sendCommand(["XTRIM", "signals:strategy", "MAXLEN", "0"]); result["redis.stream.signals:strategy"] = "trimmed"; }
                catch (e) { result["redis.stream.signals:strategy"] = `error: ${(e as Error).message}`; }

                const prefixes = ["strategy:", "regime:", "trading:", "signal:auto_approve"];
                for (const p of prefixes) {
                    const pattern = p.endsWith(":") ? `${p}*` : p;
                    try {
                        const keys: string[] = [];
                        for await (const k of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
                            if (Array.isArray(k)) keys.push(...k);
                            else keys.push(k);
                        }
                        if (keys.length > 0) await redis.del(keys);
                        result[`redis.keys.${p}`] = keys.length;
                    } catch (e) {
                        result[`redis.keys.${p}`] = `error: ${(e as Error).message}`;
                    }
                }

                logger.warn({ result }, "system/reset state wiped");
                return c.json({ ok: true, result, note: "T212 broker holdings are external and unchanged. Restart pods to clear in-memory caches." });
            } catch (err) {
                return c.json({ error: err instanceof Error ? err.message : "reset failed", partial: result }, 500);
            }
        },
    );
}
