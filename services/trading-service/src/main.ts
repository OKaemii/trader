import type { RedisClientType } from "redis";
import { createLogger, listen, registerGracefulShutdown } from "@trader/core";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";

import { loadTradingEnv } from "./env.ts";
import { wireDependencies } from "./wiring.ts";
import { buildApp, type AppDeps } from "./routes.ts";
import { TradingMode } from "./modules/orders/domain/Order.ts";

async function main(): Promise<void> {
    const env    = loadTradingEnv();
    const logger = createLogger({ service: "trading-service" });
    const deps   = await wireDependencies(env, logger);

    const appDeps: AppDeps = {
        tradingMode: env.TRADING_MODE,
        getRedis: () => getRedisClient() as unknown as Promise<Pick<RedisClientType, "get" | "set" | "del">>,
        getDb:    () => getMongoDb(),
        client:   () => deps.sharedClient,
        signal:   deps.signal,
        logger,
        accountCache: deps.sharedAccountCache,
        reconcile: deps.reconcile,
    };
    const app = buildApp(appDeps);

    // Boot sweep: revert any signals stuck at lifecycle='executing' from a prior pod that
    // crashed mid-flight.
    try {
        const reverted = await deps.dispatcher.sweepStaleExecuting(60_000);
        if (reverted > 0) logger.warn({ count: reverted }, "boot sweep reverted stale executing signals");
    } catch (err) {
        logger.warn({ err }, "boot sweep failed (signal-service likely not up yet)");
    }

    if (deps.fillsPoller) {
        deps.fillsPoller.start();
        logger.info({ intervalMs: env.FILL_POLL_INTERVAL_MS, mode: TradingMode[env.TRADING_MODE] }, "fills poller started");
    }

    deps.dispatcher.start().catch((err: unknown) => logger.error({ err }, "dispatcher crashed"));

    // In-process reconciliation loop (demo/live only). Runs a pod_catchup pass on boot, then
    // every RECONCILE_INTERVAL_MS. Preferred over an external CronJob here: it reuses the wired
    // engine and needs no JWT (a shell CronJob can't mint the internal/admin token), and the
    // service is always-on. The portal "Run now" button hits the admin endpoint for ad-hoc runs.
    let reconcileTimer: ReturnType<typeof setInterval> | undefined;
    if (deps.reconcile && env.RECONCILE_INTERVAL_MS > 0) {
        const runReconcile = (trigger: "pod_catchup" | "scheduled_4h") => {
            const endMs = Date.now();
            const startMs = endMs - env.RECONCILE_INTERVAL_MS;
            deps.reconcile!.run({ startMs, endMs, trigger })
                .then((summary) => logger.info({ summary, trigger }, "reconcile cycle complete"))
                .catch((err: unknown) => logger.warn({ err, trigger }, "reconcile cycle failed"));
        };
        runReconcile("pod_catchup");
        reconcileTimer = setInterval(() => runReconcile("scheduled_4h"), env.RECONCILE_INTERVAL_MS);
        logger.info({ intervalMs: env.RECONCILE_INTERVAL_MS, autoHeal: env.RECONCILE_AUTO_HEAL }, "reconcile loop started");
    }

    try {
        await deps.subscribeConfigInvalidations();
    } catch (err) {
        logger.warn({ err }, "config-invalidated subscribe failed (TTL still applies)");
    }

    const handle = listen({ app, port: env.PORT, logger });

    registerGracefulShutdown(logger, {
        onSignal: async () => {
            await handle.close();
            await deps.dispatcher.stop?.();
            deps.fillsPoller?.stop();
            if (reconcileTimer) clearInterval(reconcileTimer);
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[trading-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
