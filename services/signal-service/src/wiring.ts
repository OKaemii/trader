import type { Logger } from "@trader/core";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";
import { FxClient, YahooFxProvider } from "@trader/shared-fx";

import type { SignalEnv } from "./env.ts";
import { createSignalDataLayer } from "./infrastructure/data.ts";
import { MongoSignalRepository } from "./infrastructure/repositories/MongoSignalRepository.ts";
import { RedisSignalPublisher } from "./infrastructure/messaging/RedisSignalPublisher.ts";
import { RedisStrategySubscriber } from "./infrastructure/messaging/RedisStrategySubscriber.ts";
import { MongoPortfolioState } from "./infrastructure/MongoPortfolioState.ts";
import { MongoPriceLookup } from "./infrastructure/MongoPriceLookup.ts";
import { GenerateSignalsUseCase } from "./application/use-cases/GenerateSignals.ts";
import { ApproveSignalUseCase } from "./application/use-cases/ApproveSignal.ts";
import { GetSignalProgressUseCase } from "./application/use-cases/GetSignalProgress.ts";
import { RiskEngine } from "./application/services/RiskEngine.ts";
import { StrategyDecayMonitor } from "./application/services/StrategyDecayMonitor.ts";
import { AutoApprovalGate } from "./application/services/AutoApprovalGate.ts";

export async function wireDependencies(env: SignalEnv, logger: Logger) {
    const redis = await getRedisClient();
    const db    = await getMongoDb();

    // Single FxClient shared by RiskEngine NAV math + MongoPortfolioState drawdown reads.
    const fx = new FxClient(redis as never, new YahooFxProvider());

    const { manager, cache, bus, collection } = createSignalDataLayer(db, redis);
    await bus.subscribe("signals", (key) => cache.invalidate(key));

    const signalRepo  = new MongoSignalRepository(manager, cache, bus, collection);
    const riskEngine  = new RiskEngine(db, redis, fx);
    await riskEngine.init();

    const decayMonitor    = new StrategyDecayMonitor(db, redis);
    const portfolioState  = new MongoPortfolioState(db.collection("positions"), fx);
    const priceLookup     = new MongoPriceLookup(db);
    const approveSignal   = new ApproveSignalUseCase(signalRepo);
    const autoApprovalGate = new AutoApprovalGate(redis, signalRepo, approveSignal);
    const publisher       = new RedisSignalPublisher(redis);
    const generateSignals = new GenerateSignalsUseCase(
        signalRepo, publisher, portfolioState, riskEngine, undefined, decayMonitor, priceLookup, autoApprovalGate,
    );
    const findRecent      = { execute: (limit: number) => signalRepo.findRecent(limit) };
    const getProgress     = new GetSignalProgressUseCase(signalRepo, portfolioState, priceLookup);
    const subscriber      = new RedisStrategySubscriber(redis);

    return {
        logger, env, redis, db, fx,
        signalRepo, riskEngine, decayMonitor, portfolioState, priceLookup,
        approveSignal, autoApprovalGate, publisher, generateSignals,
        findRecent, getProgress, subscriber, cache, bus,
    } as const;
}

export type SignalDeps = Awaited<ReturnType<typeof wireDependencies>>;
