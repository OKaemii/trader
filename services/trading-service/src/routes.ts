import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Logger } from "@trader/core";
import type { SignalServiceClient } from "@trader/contracts";
import { Trading as TradingContracts } from "@trader/contracts";
import type { Db } from "mongodb";
import type { RedisClientType } from "redis";
import { parseAdminHeaders, parseInternalHeaders } from "@trader/shared-auth/middleware";
import { money, BASE_CURRENCY } from "@trader/shared-types";

import { Trading212Client } from "./modules/t212/infrastructure/Trading212Client.ts";
import { MongoOrderRepository } from "./modules/orders/infrastructure/MongoOrderRepository.ts";
import { T212OrderExecutor } from "./modules/t212/infrastructure/T212OrderExecutor.ts";
import { PlaceOrderUseCase } from "./modules/orders/application/PlaceOrderUseCase.ts";
import { AccountCache } from "./modules/orders/infrastructure/AccountCache.ts";
import { getSignalOrderType } from "./modules/orders/infrastructure/live-config.ts";
import { TradingMode, type OrderType } from "./modules/orders/domain/Order.ts";

// Live-trading admin approval gate. Stored in Redis so it survives restarts.
const LIVE_GATE_KEY = "trading:live_approved";

export interface AppDeps {
    tradingMode: TradingMode;
    getRedis: () => Promise<Pick<RedisClientType, "get" | "set" | "del">>;
    getDb:    () => Promise<Db>;
    client:   () => Trading212Client;
    signal?:  SignalServiceClient;
    logger?:  Logger;
    accountCache?: AccountCache;
}

const modeName = (m: TradingMode): string => TradingMode[m]!;

export function buildApp(deps: AppDeps): Hono {
    const app = new Hono();
    const { tradingMode } = deps;

    const healthOk = (c: import("hono").Context) => c.json({ status: "ok", trading_mode: modeName(tradingMode) });
    app.get("/health",                  healthOk);
    app.get("/admin/api/trading/health", healthOk);

    // ── /internal/api/trading/* (peer-to-peer) ─────────────────────────────────
    // Each route pins its allowed callers; we keep parsers per-route (not a wildcard
    // `use('/internal/api/trading/*', mw)`) so different callers can hit different routes
    // without one parser short-circuiting another.
    app.get("/internal/api/trading/positions",
        parseInternalHeaders("portfolio-service"),
        async (c) => {
            if (deps.accountCache) {
                const snap = await deps.accountCache.get();
                return c.json({ positions: snap.positions });
            }
            const positions = await deps.client().getPositions();
            return c.json({ positions });
        },
    );

    app.get("/internal/api/trading/cash",
        parseInternalHeaders("portfolio-service", "signal-service"),
        async (c) => {
            if (deps.accountCache) {
                const snap = await deps.accountCache.get();
                return c.json({ free: snap.free, total: snap.total });
            }
            const cash = await deps.client().getCash();
            return c.json(cash);
        },
    );

    // Deprecated stub: the legacy synchronous execute path is replaced by the order-dispatcher
    // queue. Kept so any old in-cluster caller gets a clear deprecation message rather than 404.
    app.post("/internal/api/trading/execute",
        parseInternalHeaders("signal-service"),
        async (c) => c.json({
            skipped: true,
            reason:  "deprecated — signals are now routed through the order-dispatcher queue. Approve via signal-service to enqueue.",
        }, 200),
    );

    // ── /admin/api/trading/* (portal) ──────────────────────────────────────────
    // Path-scoped wildcard for admin auth; admin routes never overlap /internal/api/* on
    // this Hono instance, so this is safe (each prefix only matches its own subtree).
    app.use("/admin/api/trading/*", parseAdminHeaders);

    app.post("/admin/api/trading/toggle", (c) => {
        return c.json({
            mode: modeName(tradingMode),
            message: "Change TRADING_MODE env var and redeploy to switch modes",
        });
    });

    app.post("/admin/api/trading/approve-live", async (c) => {
        if (tradingMode !== TradingMode.Live) {
            return c.json({ error: "TRADING_MODE is not set to Live — change in Helm values and redeploy first" }, 400);
        }
        const redis = await deps.getRedis();
        await redis.set(LIVE_GATE_KEY, "1");
        deps.logger?.warn("LIVE TRADING APPROVED by admin — real orders will now be placed");
        return c.json({ approved: true, message: "Live trading gate opened. Real T212 orders will be placed on next signal." });
    });

    app.post("/admin/api/trading/revoke-live", async (c) => {
        const redis = await deps.getRedis();
        await redis.del(LIVE_GATE_KEY);
        deps.logger?.warn("Live trading approval REVOKED by admin");
        return c.json({ approved: false, message: "Live trading gate closed." });
    });

    app.get("/admin/api/trading/status", async (c) => {
        const redis = await deps.getRedis();
        const approved = !!(await redis.get(LIVE_GATE_KEY));
        return c.json({ trading_mode: modeName(tradingMode), live_gate_approved: approved });
    });

    // Admin manual order placement. Schema comes from @trader/contracts so the producer
    // (this route) and any consumer (admin tooling, ad-hoc scripts) share one source of truth.
    app.post(
        "/admin/api/trading/execute",
        zValidator("json", TradingContracts.ExecuteOrderRequestSchema),
        async (c) => {
            const body = c.req.valid("json");
            const db    = await deps.getDb();
            const redis = await deps.getRedis();

            if (!deps.signal || !deps.logger) {
                return c.json({ message: "trading-service not fully wired (missing signal client / logger)" }, 500);
            }

            const orderRepo = new MongoOrderRepository(db);
            const executor  = new T212OrderExecutor(deps.client());
            const liveApproved = async (): Promise<boolean> => !!(await redis.get(LIVE_GATE_KEY));

            const useCase = new PlaceOrderUseCase({
                orderRepo,
                executor,
                liveApproved,
                signal: deps.signal,
                logger: deps.logger,
                tradingMode: deps.tradingMode,
                getSignalOrderType: async (): Promise<OrderType> => getSignalOrderType(),
            });

            const order = await useCase.execute({
                signalId:     body.signalId,
                ticker:       body.ticker,
                action:       body.action,
                targetWeight: body.targetWeight,
                confidence:   body.confidence,
                ...(body.totalNAV        ? { totalNAV: body.totalNAV } : {}),
                ...(body.currentPrice    ? { currentPrice: body.currentPrice } : {}),
                ...(body.currentQuantity !== undefined ? { currentQuantity: body.currentQuantity } : {}),
            });

            if (!order) {
                return c.json({ message: "Order skipped — check TRADING_MODE, live gate, currency match" }, 200);
            }
            return c.json({ order });
        },
    );

    app.get("/admin/api/trading/orders", async (c) => {
        const db        = await deps.getDb();
        const orderRepo = new MongoOrderRepository(db);
        const orders    = await orderRepo.findRecent(50);
        return c.json({ orders });
    });

    app.get("/admin/api/trading/cash", async (c) => {
        if (tradingMode === TradingMode.Paper) {
            return c.json({
                free:  money(0, BASE_CURRENCY),
                total: money(0, BASE_CURRENCY),
                mode:  modeName(tradingMode),
            });
        }
        try {
            const cash = await deps.client().getCash();
            return c.json({ ...cash, mode: modeName(tradingMode) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : "cash fetch failed", mode: modeName(tradingMode) }, 502);
        }
    });

    app.get("/admin/api/trading/positions", async (c) => {
        if (tradingMode === TradingMode.Paper) {
            return c.json({ positions: [], mode: modeName(tradingMode) });
        }
        try {
            const positions = await deps.client().getPositions();
            return c.json({ positions, mode: modeName(tradingMode) });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : "positions fetch failed", mode: modeName(tradingMode) }, 502);
        }
    });

    return app;
}
