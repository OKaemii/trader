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
    const logger = createLogger({ service: "trading-service", level: env.LOG_LEVEL });
    const deps   = await wireDependencies(env, logger);

    const appDeps: AppDeps = {
        tradingMode: env.TRADING_MODE,
        getRedis: () => getRedisClient() as unknown as Promise<Pick<RedisClientType, "get" | "set" | "del">>,
        getDb:    () => getMongoDb(),
        client:   () => deps.sharedClient,
        signal:   deps.signal,
        logger,
        accountCache: deps.sharedAccountCache,
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
        },
    });
}

main().catch((err) => {
    process.stderr.write(`{"level":60,"msg":"[trading-service] fatal startup failure","err":${JSON.stringify(String(err))}}\n`);
    process.exit(1);
});
