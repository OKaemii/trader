import type { Logger } from "@trader/core";
import { TradingServiceClient } from "@trader/contracts";
import { mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";
import { FxClient, YahooFxProvider } from "@trader/shared-fx";

import type { SignalEnv } from "./env.ts";
import { createSignalDataLayer } from "./shared/data.ts";
import { MongoPriceLookup } from "./shared/MongoPriceLookup.ts";
import { MongoSignalRepository } from "./modules/signals/infrastructure/MongoSignalRepository.ts";
import { RedisSignalPublisher } from "./modules/signals/infrastructure/RedisSignalPublisher.ts";
import { RedisStrategySubscriber } from "./modules/signals/infrastructure/RedisStrategySubscriber.ts";
import { GenerateSignalsUseCase } from "./modules/signals/application/GenerateSignals.ts";
import { GetSignalProgressUseCase } from "./modules/signals/application/GetSignalProgress.ts";
import { MongoPortfolioState } from "./modules/risk/infrastructure/MongoPortfolioState.ts";
import { RiskEngine } from "./modules/risk/application/RiskEngine.ts";
import { ApproveSignalUseCase } from "./modules/approval/application/ApproveSignal.ts";
import { AutoApprovalGate } from "./modules/approval/application/AutoApprovalGate.ts";
import { StrategyDecayMonitor } from "./modules/approval/application/StrategyDecayMonitor.ts";

export async function wireDependencies(env: SignalEnv, logger: Logger) {
    const redis = await getRedisClient();
    const db    = await getMongoDb();

    // Single FxClient shared by RiskEngine NAV math + MongoPortfolioState drawdown reads.
    const fx = new FxClient(redis as never, new YahooFxProvider());

    // Typed peer-service client for trading-service /internal/* — owns auth + JSON parsing.
    const tradingClient = new TradingServiceClient({
        baseUrl: env.TRADING_SERVICE_URL,
        callerService: "signal-service",
        mintToken: mintInternalJwt,
    });

    const { manager, cache, bus, collection } = createSignalDataLayer(db, redis);
    await bus.subscribe("signals", (key) => cache.invalidate(key));

    const signalRepo  = new MongoSignalRepository(manager, cache, bus, collection);
    const riskEngine  = new RiskEngine(db, redis, fx, tradingClient, logger);
    await riskEngine.init();

    const decayMonitor    = new StrategyDecayMonitor(db, redis, logger);
    const portfolioState  = new MongoPortfolioState(db.collection("positions"), fx, logger);
    const priceLookup     = new MongoPriceLookup(db);
    const approveSignal   = new ApproveSignalUseCase(signalRepo);
    const autoApprovalGate = new AutoApprovalGate(redis, signalRepo, approveSignal, tradingClient, logger);
    const publisher       = new RedisSignalPublisher(redis);
    const generateSignals = new GenerateSignalsUseCase(
        signalRepo, publisher, portfolioState, riskEngine,
        logger,
        { minActionableConfidence: env.MIN_ACTIONABLE_CONFIDENCE, volTarget: env.VOL_TARGET },
        undefined, decayMonitor, priceLookup, autoApprovalGate,
    );
    const findRecent      = { execute: (limit: number) => signalRepo.findRecent(limit) };
    const getProgress     = new GetSignalProgressUseCase(signalRepo, portfolioState, priceLookup);
    const subscriber      = new RedisStrategySubscriber(redis, {
        consumerName: `signal-service-${env.POD_NAME}`,
        logger,
    });

    return {
        logger, env, redis, db, fx, tradingClient,
        signalRepo, riskEngine, decayMonitor, portfolioState, priceLookup,
        approveSignal, autoApprovalGate, publisher, generateSignals,
        findRecent, getProgress, subscriber, cache, bus,
    } as const;
}

export type SignalDeps = Awaited<ReturnType<typeof wireDependencies>>;
