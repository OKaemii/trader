import type { Db } from "mongodb";
import type { RedisClientType } from "redis";
import type { Logger } from "@trader/core";
import { TradingServiceClient } from "@trader/contracts";
import { mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";
import { FxClient, RedisGbpUsdProvider } from "@trader/shared-fx";

import type { PortfolioEnv } from "./env.ts";
import { PositionSyncService } from "./modules/positions/application/PositionSyncService.ts";
import { PortfolioReadService } from "./modules/positions/application/PortfolioReadService.ts";

export interface PortfolioDeps {
    readonly logger: Logger;
    readonly env: PortfolioEnv;
    readonly redis: RedisClientType;
    readonly fx: FxClient;
    readonly db: Db;
    readonly trading: TradingServiceClient;
    readonly syncService: PositionSyncService;
    readonly readService: PortfolioReadService;
}

export async function wireDependencies(env: PortfolioEnv, logger: Logger): Promise<PortfolioDeps> {
    const redis = (await getRedisClient()) as unknown as RedisClientType;
    // FX centralized: read the GBP/USD market-data publishes to Redis (no upstream key); readOnly
    // so position-value conversions never overwrite the single writer's freshness timestamp.
    const fx    = new FxClient(redis as never, new RedisGbpUsdProvider(redis as never), { readOnly: true });
    const db    = await getMongoDb();

    const trading = new TradingServiceClient({
        baseUrl:       env.TRADING_SERVICE_URL,
        callerService: "portfolio-service",
        mintToken:     mintInternalJwt,
    });

    const syncService = new PositionSyncService({ db, fx, trading, logger });
    const readService = new PortfolioReadService({ db, fx, logger });

    return { logger, env, redis, fx, db, trading, syncService, readService };
}
