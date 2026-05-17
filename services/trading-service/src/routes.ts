import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Db } from "mongodb";
import type { RedisClientType } from "redis";
import { requireAuth, requireRole, requireInternal, requireCaller } from '@trader/shared-auth/middleware';
import { money, BASE_CURRENCY } from "@trader/shared-types";

import { Trading212Client } from "./infrastructure/t212.ts";
import { MongoOrderRepository } from "./infrastructure/MongoOrderRepository.ts";
import { T212OrderExecutor } from "./infrastructure/T212OrderExecutor.ts";
import { PlaceOrderUseCase } from "./application/use-cases/PlaceOrderUseCase.ts";
import { AccountCache } from "./infrastructure/account-cache.ts";
import { getSignalOrderType } from "./infrastructure/live-config.ts";
import { TradingMode } from "./domain/entities/Order.ts";

// Live-trading admin approval gate. Stored in Redis so it survives restarts.
const LIVE_GATE_KEY = "trading:live_approved";

export interface AppDeps {
    tradingMode: TradingMode;
    getRedis: () => Promise<Pick<RedisClientType, "get" | "set" | "del">>;
    getDb:    () => Promise<Db>;
    client:   () => Trading212Client;
    accountCache?: AccountCache;
}

const modeName = (m: TradingMode): string => TradingMode[m]!;

export function buildApp(deps: AppDeps): Hono {
    const app = new Hono();
    const { tradingMode } = deps;

    app.get("/health", (c) => c.json({ status: "ok", trading_mode: modeName(tradingMode) }));

    app.get("/internal/trading/positions", requireInternal, requireCaller("portfolio-service"), async (c) => {
        if (deps.accountCache) {
            const snap = await deps.accountCache.get();
            return c.json({ positions: snap.positions });
        }
        const positions = await deps.client().getPositions();
        return c.json({ positions });
    });

    app.get("/internal/trading/cash", requireInternal, requireCaller("portfolio-service", "signal-service"), async (c) => {
        if (deps.accountCache) {
            const snap = await deps.accountCache.get();
            return c.json({ free: snap.free, total: snap.total });
        }
        const cash = await deps.client().getCash();
        return c.json(cash);
    });

    app.post("/internal/signals/trading/execute", requireInternal, requireCaller("signal-service"), async (c) => {
        return c.json({
            skipped: true,
            reason:  "deprecated — signals are now routed through the order-dispatcher queue. Approve via signal-service to enqueue.",
        }, 200);
    });

    app.use("/api/admin/*", requireAuth, requireRole("admin"));
    const admin = app;

    admin.post("/api/admin/trading/toggle", (c) => {
        return c.json({
            mode: modeName(tradingMode),
            message: "Change TRADING_MODE env var and redeploy to switch modes",
        });
    });

    admin.post("/api/admin/trading/approve-live", async (c) => {
        if (tradingMode !== TradingMode.Live) {
            return c.json({ error: "TRADING_MODE is not set to Live — change in Helm values and redeploy first" }, 400);
        }
        const redis = await deps.getRedis();
        await redis.set(LIVE_GATE_KEY, "1");
        console.warn("[TradingService] LIVE TRADING APPROVED by admin — real orders will now be placed");
        return c.json({ approved: true, message: "Live trading gate opened. Real T212 orders will be placed on next signal." });
    });

    admin.post("/api/admin/trading/revoke-live", async (c) => {
        const redis = await deps.getRedis();
        await redis.del(LIVE_GATE_KEY);
        console.warn("[TradingService] Live trading approval REVOKED by admin");
        return c.json({ approved: false, message: "Live trading gate closed." });
    });

    admin.get("/api/admin/trading/status", async (c) => {
        const redis = await deps.getRedis();
        const approved = !!(await redis.get(LIVE_GATE_KEY));
        return c.json({ trading_mode: modeName(tradingMode), live_gate_approved: approved });
    });

    // Boundary validation via zod. Replaces the hand-rolled checks that previously caught
    // the malformed totalNAV / currentPrice shapes — those now fail at the validator middleware
    // with a 400 + zod issue list, before any handler code runs.
    const MoneyJson = z.object({
        amount: z.number(),
        currency: z.enum(["GBP", "USD"]),
    });
    const ExecuteBody = z.object({
        signalId: z.string().min(1),
        ticker: z.string().min(1),
        action: z.enum(["BUY", "SELL"]),
        targetWeight: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1),
        totalNAV: MoneyJson.optional(),
        currentPrice: MoneyJson.optional(),
        currentQuantity: z.number().int().nonnegative().optional(),
    });
    admin.post("/api/admin/trading/execute", zValidator("json", ExecuteBody), async (c) => {
        const body = c.req.valid("json");
        const db    = await deps.getDb();
        const redis = await deps.getRedis();

        const orderRepo = new MongoOrderRepository(db);
        const executor  = new T212OrderExecutor(deps.client());
        const liveApproved = async (): Promise<boolean> => !!(await redis.get(LIVE_GATE_KEY));

        const useCase = new PlaceOrderUseCase(orderRepo, executor, liveApproved, getSignalOrderType);
        // Optional fields are stripped if undefined to satisfy exactOptionalPropertyTypes.
        const order   = await useCase.execute({
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
    });

    admin.get("/api/admin/trading/orders", async (c) => {
        const db        = await deps.getDb();
        const orderRepo = new MongoOrderRepository(db);
        const orders    = await orderRepo.findRecent(50);
        return c.json({ orders });
    });

    admin.get("/api/admin/trading/cash", async (c) => {
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

    admin.get("/api/admin/trading/positions", async (c) => {
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
