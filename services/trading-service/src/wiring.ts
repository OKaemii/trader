import type { RedisClientType } from "redis";
import type { Logger } from "@trader/core";
import { SignalServiceClient } from "@trader/contracts";
import { mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient, subscribe } from "@trader/shared-redis";
import { FxClient, YahooFxProvider } from "@trader/shared-fx";

import type { TradingEnv } from "./env.ts";
import { Trading212Client } from "./infrastructure/t212.ts";
import { MongoOrderRepository } from "./infrastructure/MongoOrderRepository.ts";
import { AccountCache } from "./infrastructure/account-cache.ts";
import { OrderDispatcher } from "./infrastructure/order-dispatcher.ts";
import { FillsPoller } from "./application/services/FillsPoller.ts";
import { TradingMode } from "./domain/entities/Order.ts";
import { invalidateSignalOrderType, configureLiveConfig, parseSignalOrderType } from "./infrastructure/live-config.ts";

export async function wireDependencies(env: TradingEnv, logger: Logger) {
    configureLiveConfig({ logger, envDefault: parseSignalOrderType(env.SIGNAL_ORDER_TYPE) });
    const live   = env.TRADING_MODE === TradingMode.Live;
    const apiKey   = live ? env.T212_API_KEY    ?? "" : env.T212_API_KEY_DEMO    ?? "";
    const apiKeyId = live ? env.T212_API_KEY_ID ?? "" : env.T212_API_KEY_ID_DEMO ?? "";
    const sharedClient = new Trading212Client({ apiKey, apiKeyId, live });

    const sharedAccountCache = new AccountCache(sharedClient, { ttlMs: env.ACCOUNT_CACHE_TTL_MS, logger });

    let fxClient: FxClient | null = null;
    const getFxClient = async (): Promise<FxClient> => {
        if (fxClient) return fxClient;
        const redis = await getRedisClient();
        fxClient = new FxClient(redis as never, new YahooFxProvider());
        return fxClient;
    };

    // Typed peer client for signal-service. Single source of truth for the JWT mint +
    // base URL + per-endpoint contract. Used by dispatcher, FillsPoller, PlaceOrderUseCase.
    const signal = new SignalServiceClient({
        baseUrl:       env.SIGNAL_SERVICE_URL,
        callerService: "trading-service",
        mintToken:     mintInternalJwt,
    });

    const fillsPoller = env.TRADING_MODE !== TradingMode.Paper
        ? new FillsPoller(
            new MongoOrderRepository(await getMongoDb()),
            sharedClient,
            signal,
            env.FILL_POLL_INTERVAL_MS,
            logger,
        )
        : null;

    const dispatcher = new OrderDispatcher({
        tradingMode:         env.TRADING_MODE,
        client:              sharedClient,
        accountCache:        sharedAccountCache,
        signal,
        logger,
        getDb:               () => getMongoDb(),
        getRedis:            () => getRedisClient() as unknown as Promise<Pick<RedisClientType, "get">>,
        fxFromGBP:           async (amount, target) => (await getFxClient()).fromGBP(amount, target),
        minIntervalMs:       env.ORDER_MIN_INTERVAL_MS,
        maxAttempts:         env.ORDER_MAX_ATTEMPTS,
        queueTtlMs:          env.QUEUE_TTL_MS,
        priceDriftTolerance: env.PRICE_DRIFT_TOLERANCE,
    });

    return {
        logger,
        env,
        sharedClient,
        sharedAccountCache,
        signal,
        fillsPoller,
        dispatcher,
        getFxClient,
        subscribeConfigInvalidations: async () => {
            const redis = await getRedisClient();
            await subscribe(redis as unknown as RedisClientType, "config:invalidated", () => {
                invalidateSignalOrderType();
                logger.info("live-config cache invalidated via pubsub");
            });
        },
    } as const;
}

export type TradingDeps = Awaited<ReturnType<typeof wireDependencies>>;
