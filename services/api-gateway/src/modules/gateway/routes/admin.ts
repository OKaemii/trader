import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Logger } from "@trader/core";
import { Gateway as GatewayContracts } from "@trader/contracts";
import { requireAuth, requireRole, mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";
import { proxy } from "../infrastructure/proxy.ts";

export function createAdminRouter(logger: Logger): Hono {
    const admin = new Hono();
    admin.use("*", requireAuth, requireRole("admin"));

    admin.get("/api/admin/signals/history",       (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/signals/approve/:id",  (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/signals/retry/:id",    (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/signals/cancel/:id",   (c) => proxy("http://signal-service:3003", c));
    admin.get("/api/admin/signals/auto-approve",  (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/signals/auto-approve", (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/trading/toggle",             (c) => proxy("http://trading-service:3005", c));
    admin.post("/api/admin/trading/approve-live",       (c) => proxy("http://trading-service:3005", c));
    admin.post("/api/admin/trading/revoke-live",        (c) => proxy("http://trading-service:3005", c));
    admin.get("/api/admin/trading/status",              (c) => proxy("http://trading-service:3005", c));
    admin.post("/api/admin/trading/execute",            (c) => proxy("http://trading-service:3005", c));
    admin.get("/api/admin/trading/orders",              (c) => proxy("http://trading-service:3005", c));
    admin.get("/api/admin/trading/cash",                (c) => proxy("http://trading-service:3005", c));
    admin.get("/api/admin/trading/positions",           (c) => proxy("http://trading-service:3005", c));
    admin.get("/api/admin/users",                       (c) => proxy("http://auth-service:3001", c));
    admin.get("/api/admin/risk/status",                 (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/risk/circuit-breaker/reset", (c) => proxy("http://signal-service:3003", c));
    admin.post("/api/admin/backtest/run",               (c) => proxy("http://backtest-engine:8001", c));
    admin.get("/api/admin/backtest/results",            (c) => proxy("http://backtest-engine:8001", c));
    admin.get("/api/admin/universe/overrides",          (c) => proxy("http://market-data-service:3002", c));
    admin.put("/api/admin/universe/overrides",          (c) => proxy("http://market-data-service:3002", c));
    admin.post("/api/admin/universe/refresh",           (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/config",          (c) => proxy("http://market-data-service:3002", c));
    admin.put("/api/admin/market-data/config",          (c) => proxy("http://market-data-service:3002", c));
    admin.post("/api/admin/market-data/backfill",       (c) => proxy("http://market-data-service:3002", c));
    admin.post("/api/admin/market-data/clear-cache",    (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/bars/:ticker",    (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/coverage",        (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/provider-info",   (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/calendar",        (c) => proxy("http://market-data-service:3002", c));
    admin.get("/api/admin/market-data/holiday-sources", (c) => proxy("http://market-data-service:3002", c));
    admin.post("/api/admin/market-data/holiday-refresh",(c) => proxy("http://market-data-service:3002", c));

    // market-data /health surfaces next_poll_ts + universe size etc. proxy() rewrites the
    // request path 1:1 to the upstream, so to hit the upstream's /health we forward to a
    // direct fetch. The portal needs the full payload (not just OK/error).
    admin.get("/api/admin/market-data/health", async (c) => {
        const r = await fetch("http://market-data-service:3002/health");
        const body = await r.text();
        return new Response(body, {
            status: r.status,
            headers: { "content-type": r.headers.get("content-type") ?? "application/json" },
        });
    });

    admin.get("/api/admin/system/status", async (c) => {
        const jwt = await mintInternalJwt("api-gateway");
        const headers = { Authorization: `Bearer ${jwt}` };
        const [marketRes, strategyRes] = await Promise.allSettled([
            fetch("http://market-data-service:3002/health", { headers }).then(r => r.json()),
            fetch("http://strategy-engine:8000/status",     { headers }).then(r => r.json()),
        ]);
        return c.json({
            market_data: marketRes.status === "fulfilled" ? marketRes.value : { error: "unavailable" },
            strategy:    strategyRes.status === "fulfilled" ? strategyRes.value : { error: "unavailable" },
        });
    });

    admin.get("/api/admin/system/health", async (c) => {
        const services = [
            ["auth",          "http://auth-service:3001/health"],
            ["market-data",   "http://market-data-service:3002/health"],
            ["strategy",      "http://strategy-engine:8000/health"],
            ["signals",       "http://signal-service:3003/health"],
            ["notifications", "http://notification-service:3004/health"],
            ["trading",       "http://trading-service:3005/health"],
            ["portfolio",     "http://portfolio-service:3006/health"],
            ["backtest",      "http://backtest-engine:8001/health"],
        ] as const;
        const jwt = await mintInternalJwt("api-gateway");
        const results = await Promise.allSettled(
            services.map(async ([name, url]) => {
                const r = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` } });
                return { name, ok: r.ok, status: r.status };
            }),
        );
        return c.json(results.map((r) => r.status === "fulfilled" ? r.value : { name: "unknown", ok: false }));
    });

    // System reset — wipes trading history + strategy state to start fresh from today.
    // Drops: signals, ohlcv_bars, orders, positions, backtest_results, instrument_registry,
    //        topology_snapshots, strategy_health_log, model_versions, feature_importance_log,
    //        risk_state, risk_rejections, bad_ticks.
    // Preserves: users, portal_universe_overrides, portal_market_config.
    // Real T212 broker state is NOT touched.
    admin.post(
        "/api/admin/system/reset",
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

    return admin;
}
