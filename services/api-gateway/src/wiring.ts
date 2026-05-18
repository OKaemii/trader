import type { Logger } from "@trader/core";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";

import type { GatewayEnv } from "./env.ts";

export interface GatewayDeps {
    readonly logger: Logger;
    readonly env: GatewayEnv;
    readonly getMongoDb: typeof getMongoDb;
    readonly getRedisClient: typeof getRedisClient;
}

export function wireDependencies(env: GatewayEnv, logger: Logger): GatewayDeps {
    return { logger, env, getMongoDb, getRedisClient };
}
