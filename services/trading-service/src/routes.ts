import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Logger } from "@trader/core";
import type { SignalServiceClient } from "@trader/contracts";
import { Trading as TradingContracts } from "@trader/contracts";
import type { Db } from "mongodb";
import type { RedisClientType } from "redis";
import { parseAdminHeaders, parseInternalHeaders } from "@trader/shared-auth/middleware";
import { money, BASE_CURRENCY } from "@trader/shared-types";
import { getPgPool } from "@trader/shared-pg";

import { Trading212Client } from "./modules/t212/infrastructure/Trading212Client.ts";
import { MongoOrderRepository } from "./modules/orders/infrastructure/MongoOrderRepository.ts";
import { T212OrderExecutor } from "./modules/t212/infrastructure/T212OrderExecutor.ts";
import { PlaceOrderUseCase } from "./modules/orders/application/PlaceOrderUseCase.ts";
import { AccountCache } from "./modules/orders/infrastructure/AccountCache.ts";
import { getSignalOrderType } from "./modules/orders/infrastructure/live-config.ts";
import { TradingMode, type OrderType } from "./modules/orders/domain/Order.ts";
import { FlattenAllUseCase } from "./modules/orders/application/FlattenAllUseCase.ts";
import { computeEquityKpis, repairLegacyNavPoint } from "./modules/reconciliation/application/equity-kpis.ts";
import type { FillFilter, FillRow } from "./modules/reconciliation/infrastructure/FillsHistoryStore.ts";

// Live-trading admin approval gate. Stored in Redis so it survives restarts.
const LIVE_GATE_KEY = "trading:live_approved";

// Reconciliation runner + ledger reads (built in wiring.ts; null in paper mode — no broker
// truth to reconcile). The route layer depends on this shape, not on the engine concretion.
export interface ReconcileRunner {
    run: (w: { startMs: number; endMs: number; trigger: 'manual' | 'scheduled_4h' | 'scheduled_nightly' | 'pod_catchup' }) => Promise<unknown>;
    acknowledge: (findingId: number, by: string) => Promise<void>;
    listFindings: (openOnly: boolean, limit: number) => Promise<Record<string, unknown>[]>;
    listNav: (limit: number) => Promise<Record<string, unknown>[]>;
    listFills: (f: FillFilter) => Promise<FillRow[]>;
}

export interface AppDeps {
    tradingMode: TradingMode;
    getRedis: () => Promise<Pick<RedisClientType, "get" | "set" | "del">>;
    getDb:    () => Promise<Db>;
    client:   () => Trading212Client;
    signal?:  SignalServiceClient;
    logger?:  Logger;
    accountCache?: AccountCache;
    reconcile?: ReconcileRunner | null;
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
            // Paper-mode parity with the admin route (~195): no broker call, return a real
            // GBP zero. Without this, a Paper deployment would attempt a live T212 getCash
            // here while the admin route the portal reads returns £0 — the two cash views
            // would disagree, and RiskEngine would read a non-zero broker figure in a mode
            // that places no orders.
            if (tradingMode === TradingMode.Paper) {
                return c.json({ free: money(0, BASE_CURRENCY), total: money(0, BASE_CURRENCY) });
            }
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

    // Flatten — cancel every resting order + market-sell every open position. The hard
    // "get me out now" panic action. Demo/live only (no broker positions in Paper).
    app.post("/admin/api/trading/flatten", async (c) => {
        if (tradingMode === TradingMode.Paper) {
            return c.json({ error: "flatten is a no-op in Paper mode (no broker positions)" }, 400);
        }
        const flatten = new FlattenAllUseCase(deps.client(), deps.logger ?? ({ warn() {} } as unknown as Logger));
        const result = await flatten.execute();
        deps.logger?.warn({ result }, "flatten endpoint invoked by admin");
        return c.json({ ok: true, ...result });
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

    // ── Reconciliation (demo/live only) ─────────────────────────────────────────
    const needReconcile = (c: import("hono").Context): ReconcileRunner | null => {
        if (!deps.reconcile) {
            c.json({ error: "reconciliation unavailable in paper mode" }, 400);
            return null;
        }
        return deps.reconcile;
    };

    // Manual / cron-triggered run. Body { window_start_ms?, window_end_ms?, trigger? } —
    // defaults to the last 4h. The CronJob hits this with explicit windows.
    app.post("/admin/api/trading/reconcile/run", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const body = await c.req.json().catch(() => ({})) as {
            window_start_ms?: number; window_end_ms?: number;
            trigger?: 'manual' | 'scheduled_4h' | 'scheduled_nightly' | 'pod_catchup';
        };
        const endMs = body.window_end_ms ?? Date.now();
        const startMs = body.window_start_ms ?? endMs - 4 * 60 * 60 * 1000;
        const summary = await r.run({ startMs, endMs, trigger: body.trigger ?? 'manual' });
        return c.json({ summary });
    });

    app.post("/admin/api/trading/reconcile/findings/:id/acknowledge", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const id = Number(c.req.param("id"));
        if (!Number.isFinite(id)) return c.json({ error: "invalid finding id" }, 400);
        const body = await c.req.json().catch(() => ({})) as { by?: string };
        await r.acknowledge(id, body.by ?? "operator");
        return c.json({ acknowledged: id });
    });

    app.get("/admin/api/trading/reconcile/findings", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const openOnly = c.req.query("open") !== "false";
        const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
        return c.json({ findings: await r.listFindings(openOnly, limit) });
    });

    app.get("/admin/api/trading/reconcile/nav", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const limit = Math.min(Number(c.req.query("limit") ?? "200"), 1000);
        return c.json({ nav: await r.listNav(limit) });
    });

    // Equity curve + performance KPIs over nav_history (demo/live only — paper has no NAV history).
    // Honest realised return + drawdown only; annualised Sharpe/vol live in the backtest validator.
    app.get("/admin/api/trading/equity", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const days = Math.min(Math.max(Number(c.req.query("days") ?? "90"), 1), 365);
        const rows = await r.listNav(Math.min(days * 8, 2000));   // ~6 snapshots/day; pull generously
        const cutoff = Date.now() - days * 86_400_000;
        const series = rows
            .map((row) => repairLegacyNavPoint({   // correct pre-2026-06-03 double-counted NAV at read time
                t: new Date(row.snapshot_at as string).getTime(),
                nav: Number(row.nav), cash: Number(row.cash), positionsValue: Number(row.positions_value),
            }))
            .filter((p) => Number.isFinite(p.t) && p.t >= cutoff)
            .sort((a, b) => a.t - b.t);                            // listNav is DESC → re-order ASC
        return c.json({ ...computeEquityKpis(series), days });
    });

    // Trade audit — filterable fills ledger (demo/live; fills_history is FillsPoller-populated).
    app.get("/admin/api/trading/fills", async (c) => {
        const r = needReconcile(c);
        if (!r) return c.res;
        const ticker = c.req.query("ticker")?.trim().toUpperCase() || undefined;
        const sideRaw = c.req.query("side");
        const side = sideRaw === "BUY" || sideRaw === "SELL" ? sideRaw : undefined;
        const days = Math.min(Math.max(Number(c.req.query("days") ?? "30"), 1), 365);
        const limit = Math.min(Number(c.req.query("limit") ?? "200"), 1000);
        const fills = await r.listFills({ ticker, side, sinceMs: Date.now() - days * 86_400_000, limit });
        return c.json({ fills, days });
    });

    // ── TCA (transaction-cost analysis) ─────────────────────────────────────────
    // Per-day cost summary + recent rows from tca_log. Reads Timescale directly (admin-authed).
    app.get("/admin/api/trading/tca", async (c) => {
        const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
        try {
            const pool = getPgPool();
            const [daily, recent] = await Promise.all([
                pool.query(
                    `SELECT date_trunc('day', fill_at) AS day, count(*) AS fills,
                            avg(total_cost_bps) AS avg_cost_bps, avg(fill_slip_bps) AS avg_fill_slip_bps,
                            count(total_cost_bps) AS cost_coverage
                     FROM tca_log GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
                ),
                pool.query(
                    `SELECT computed_at, ticker, side, signal_id, fill_price, arrival_mid, fill_mid,
                            arrival_slip_bps, fill_slip_bps, total_cost_bps,
                            quote_arrival_source, quote_fill_source
                     FROM tca_log ORDER BY computed_at DESC LIMIT $1`,
                    [limit],
                ),
            ]);
            return c.json({ daily: daily.rows, recent: recent.rows });
        } catch (e) {
            return c.json({ error: e instanceof Error ? e.message : "tca query failed", daily: [], recent: [] }, 200);
        }
    });

    return app;
}
