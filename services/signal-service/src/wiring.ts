import type { Logger } from "@trader/core";
import { TradingServiceClient } from "@trader/contracts";
import { mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient } from "@trader/shared-redis";
import { FxClient, RedisGbpUsdProvider } from "@trader/shared-fx";

import type { SignalEnv } from "./env.ts";
import { createSignalDataLayer } from "./shared/data.ts";
import { PriceLookup } from "./shared/PriceLookup.ts";
import { MongoSignalRepository } from "./modules/signals/infrastructure/MongoSignalRepository.ts";
import { MongoHeldSetSnapshotStore } from "./modules/signals/infrastructure/MongoHeldSetSnapshotStore.ts";
import { RedisSignalPublisher } from "./modules/signals/infrastructure/RedisSignalPublisher.ts";
import { RedisStrategySubscriber } from "./modules/signals/infrastructure/RedisStrategySubscriber.ts";
import { GenerateSignalsUseCase } from "./modules/signals/application/GenerateSignals.ts";
import { GetSignalProgressUseCase } from "./modules/signals/application/GetSignalProgress.ts";
import { GetTelemetrySnapshotUseCase } from "./modules/signals/application/GetTelemetrySnapshot.ts";
import { MongoPortfolioState } from "./modules/risk/infrastructure/MongoPortfolioState.ts";
import { RiskEngine } from "./modules/risk/application/RiskEngine.ts";
import { TripRecorder } from "./modules/risk/application/TripRecorder.ts";
import { ApproveSignalUseCase } from "./modules/approval/application/ApproveSignal.ts";
import { AutoApprovalGate } from "./modules/approval/application/AutoApprovalGate.ts";
import { StrategyDecayMonitor } from "./modules/approval/application/StrategyDecayMonitor.ts";
import { MongoPieRepository } from "./modules/pie/infrastructure/MongoPieRepository.ts";
import { PieManager } from "./modules/pie/application/PieManager.ts";
import { MongoTradePlanRepository } from "./modules/tradeplans/infrastructure/MongoTradePlanRepository.ts";
import { MongoAlertRuleRepository } from "./modules/alerts/infrastructure/MongoAlertRuleRepository.ts";
import { LatestBarReader } from "./modules/alerts/infrastructure/LatestBarReader.ts";
import { AlertWatcher } from "./modules/alerts/application/AlertWatcher.ts";

export async function wireDependencies(env: SignalEnv, logger: Logger) {
    const redis = await getRedisClient();
    const db    = await getMongoDb();

    // Single FxClient shared by RiskEngine NAV math + MongoPortfolioState drawdown reads. FX is
    // centralized: market-data-service publishes GBP/USD to Redis; we read it (no upstream key) and
    // never write back (readOnly) so we don't clobber the single writer's freshness timestamp.
    const fx = new FxClient(redis as never, new RedisGbpUsdProvider(redis as never), { readOnly: true });

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
    const tripRecorder = new TripRecorder(db, signalRepo, tradingClient, logger);
    riskEngine.attachTripPipeline(signalRepo, tripRecorder);
    await riskEngine.init();

    const decayMonitor    = new StrategyDecayMonitor(db, redis, logger);
    const portfolioState  = new MongoPortfolioState(db.collection("positions"), fx, logger);
    const priceLookup     = new PriceLookup(db);
    const approveSignal   = new ApproveSignalUseCase(signalRepo);
    const autoApprovalGate = new AutoApprovalGate(redis, signalRepo, approveSignal, tradingClient, logger);
    const pieRepo         = new MongoPieRepository(db);
    const pieManager      = new PieManager(pieRepo, logger);
    const tradePlanRepo   = new MongoTradePlanRepository(db);
    const alertRuleRepo   = new MongoAlertRuleRepository(db);
    const alertWatcher    = new AlertWatcher(
        alertRuleRepo, new LatestBarReader(db), redis as never, logger, env.ALERT_WATCH_INTERVAL_MS,
    );
    const publisher       = new RedisSignalPublisher(redis, logger);
    const heldSetSnapshotStore = new MongoHeldSetSnapshotStore(db, logger);
    const generateSignals = new GenerateSignalsUseCase(
        signalRepo, publisher, portfolioState, riskEngine,
        logger,
        {
            minActionableConfidence: env.MIN_ACTIONABLE_CONFIDENCE,
            volTarget:               env.VOL_TARGET,
            minPositivePeers:        env.MIN_POSITIVE_PEERS,
            minScoreEpsilon:         env.MIN_SCORE_EPSILON,
        },
        undefined, decayMonitor, priceLookup, autoApprovalGate, pieManager, heldSetSnapshotStore,
    );
    const findRecent      = { execute: (limit: number) => signalRepo.findRecent(limit) };
    const getProgress     = new GetSignalProgressUseCase(signalRepo, portfolioState, priceLookup);
    const telemetrySnapshot = new GetTelemetrySnapshotUseCase(db, fx, decayMonitor, riskEngine, logger);
    // WP2.3: multiplex across one subscriber per strategy-output stream. Each gets its
    // own consumer group keyed by stream name so multiple signal-service pods can scale
    // horizontally without re-delivering messages, and a stream that goes idle (e.g. the
    // daily worker between session closes) doesn't block reads from the others.
    const streamList = env.STRATEGY_INPUT_STREAMS
        .split(',').map((s) => s.trim()).filter(Boolean);
    if (streamList.length === 0) {
        throw new Error('STRATEGY_INPUT_STREAMS resolved to empty — refusing to start with no subscriber');
    }
    const subscribers = streamList.map((stream) => new RedisStrategySubscriber(redis, {
        stream,
        consumerGroup: `signal-service:${stream}`,
        consumerName:  `signal-service-${env.POD_NAME}`,
        logger,
    }));
    logger.info({ streams: streamList }, 'strategy subscribers wired');

    return {
        logger, env, redis, db, fx, tradingClient,
        signalRepo, riskEngine, tripRecorder, decayMonitor, portfolioState, priceLookup,
        approveSignal, autoApprovalGate, publisher, generateSignals, pieRepo, tradePlanRepo,
        alertRuleRepo, alertWatcher,
        findRecent, getProgress, telemetrySnapshot, subscribers, cache, bus,
    } as const;
}

export type SignalDeps = Awaited<ReturnType<typeof wireDependencies>>;
