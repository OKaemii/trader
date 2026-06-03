import type { RedisClientType } from "redis";
import type { Logger } from "@trader/core";
import { SignalServiceClient } from "@trader/contracts";
import { mintInternalJwt } from "@trader/shared-auth";
import { getMongoDb } from "@trader/shared-mongo";
import { getRedisClient, subscribe } from "@trader/shared-redis";
import { FxClient, YahooFxProvider } from "@trader/shared-fx";

import type { TradingEnv } from "./env.ts";
import { Trading212Client } from "./modules/t212/infrastructure/Trading212Client.ts";
import { InstrumentMetadataCache } from "./modules/t212/infrastructure/InstrumentMetadataCache.ts";
import { MongoOrderRepository } from "./modules/orders/infrastructure/MongoOrderRepository.ts";
import { AccountCache } from "./modules/orders/infrastructure/AccountCache.ts";
import { OrderDispatcher } from "./modules/orders/infrastructure/OrderDispatcher.ts";
import { FillsPoller } from "./modules/fills/application/FillsPoller.ts";
import { FillsHistoryStore, type FillFilter, type FillRow } from "./modules/reconciliation/infrastructure/FillsHistoryStore.ts";
import { TcaWriter } from "./modules/tca/infrastructure/TcaWriter.ts";
import { ReconciliationStore } from "./modules/reconciliation/infrastructure/ReconciliationStore.ts";
import { T212HistoryWalker } from "./modules/reconciliation/infrastructure/T212HistoryWalker.ts";
import { MongoSystemReader } from "./modules/reconciliation/infrastructure/MongoSystemReader.ts";
import { MongoHealer } from "./modules/reconciliation/infrastructure/MongoHealer.ts";
import { Reconciliation } from "./modules/reconciliation/application/Reconciliation.ts";
import type { T212Position } from "./modules/t212/infrastructure/Trading212Client.ts";
import { PriceLookup } from "./shared/PriceLookup.ts";
import { TradingMode } from "./modules/orders/domain/Order.ts";
import { invalidateSignalOrderType, configureLiveConfig, parseSignalOrderType, getSignalOrderType } from "./modules/orders/infrastructure/live-config.ts";

export async function wireDependencies(env: TradingEnv, logger: Logger) {
    configureLiveConfig({ logger, envDefault: parseSignalOrderType(env.SIGNAL_ORDER_TYPE) });
    const live   = env.TRADING_MODE === TradingMode.Live;
    const apiKey   = live ? env.T212_API_KEY    ?? "" : env.T212_API_KEY_DEMO    ?? "";
    const apiKeyId = live ? env.T212_API_KEY_ID ?? "" : env.T212_API_KEY_ID_DEMO ?? "";
    const sharedClient = new Trading212Client({ apiKey, apiKeyId, live });

    // Shared price lookup is reused by AccountCache + FillsPoller to detect pence-quoted
    // LSE listings (T212 reports pence, our bars are GBP — ratio ≈100 → scale /100).
    const priceLookup = new PriceLookup(await getMongoDb());

    const sharedAccountCache = new AccountCache(sharedClient, {
        ttlMs: env.ACCOUNT_CACHE_TTL_MS,
        logger,
        priceLookup,
    });

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

    // Append-only fills ledger (Timescale fills_history) — written by FillsPoller, read by
    // reconciliation. Safe to construct in any mode (lazy getPgPool); only used demo/live.
    const fillsHistoryStore = new FillsHistoryStore();

    const fillsPoller = env.TRADING_MODE !== TradingMode.Paper
        ? new FillsPoller(
            new MongoOrderRepository(await getMongoDb()),
            sharedClient,
            signal,
            env.FILL_POLL_INTERVAL_MS,
            logger,
            priceLookup,
            fillsHistoryStore,
            new TcaWriter(),
        )
        : null;

    // Instrument metadata cache — only wired in demo/live (paper mode never calls T212
    // so a metadata fetch on boot would fail with missing credentials). Eager-load in
    // background; the first signal that arrives before completion gets the in-memory
    // fallback rules (4 dp / 0.0001 minQuantity) for one cycle, then the populated cache.
    let instrumentMetadata: InstrumentMetadataCache | undefined;
    if (env.TRADING_MODE !== TradingMode.Paper) {
        instrumentMetadata = new InstrumentMetadataCache(sharedClient, logger);
        instrumentMetadata.load().catch((err) => {
            logger.warn({ err }, 'initial instrument-metadata load failed — will retry on first lookup');
        });
    }

    const dispatcher = new OrderDispatcher({
        tradingMode:         env.TRADING_MODE,
        client:              sharedClient,
        accountCache:        sharedAccountCache,
        ...(instrumentMetadata ? { instrumentMetadata } : {}),
        signal,
        logger,
        getDb:               () => getMongoDb(),
        getRedis:            () => getRedisClient() as unknown as Promise<Pick<RedisClientType, "get">>,
        fxFromGBP:           async (amount, target) => (await getFxClient()).fromGBP(amount, target),
        minIntervalMs:       env.ORDER_MIN_INTERVAL_MS,
        maxAttempts:         env.ORDER_MAX_ATTEMPTS,
        queueTtlMs:          env.QUEUE_TTL_MS,
        marketRetryWindowMs: env.MARKET_RETRY_WINDOW_MS,
        getOrderType:        () => getSignalOrderType(),
        priceDriftTolerance: env.PRICE_DRIFT_TOLERANCE,
        driftQuoteFreshnessMs: env.DRIFT_QUOTE_FRESHNESS_MS,
    });

    // ── Reconciliation (demo/live only — paper has no broker truth to reconcile against) ──
    // Observe-only by default (RECONCILE_AUTO_HEAL=false): findings + NAV are recorded, no
    // Mongo mutations. NAV positions-value is FX-summed to GBP; an FX outage degrades it to
    // cash-only rather than failing the cycle.
    const reconcileStore = new ReconciliationStore();
    let reconcile: {
        run: (w: { startMs: number; endMs: number; trigger: 'manual' | 'scheduled_4h' | 'scheduled_nightly' | 'pod_catchup' }) => Promise<unknown>;
        acknowledge: (findingId: number, by: string) => Promise<void>;
        listFindings: (openOnly: boolean, limit: number) => Promise<Record<string, unknown>[]>;
        listNav: (limit: number) => Promise<Record<string, unknown>[]>;
        listFills: (f: FillFilter) => Promise<FillRow[]>;
    } | null = null;

    if (env.TRADING_MODE !== TradingMode.Paper) {
        const db = await getMongoDb();
        const valuePositionsGbp = async (positions: T212Position[]): Promise<number> => {
            try {
                const fx = await getFxClient();
                let sum = 0;
                for (const p of positions) sum += await fx.toGBP(p.currentValue);
                return sum;
            } catch (err) {
                logger.warn({ err }, "reconcile: FX unavailable — NAV positions-value degraded to 0 (cash-only)");
                return 0;
            }
        };
        const engine = new Reconciliation({
            broker: sharedClient,
            history: new T212HistoryWalker(sharedClient, env.RECONCILE_MAX_HISTORY_PAGES),
            system: new MongoSystemReader(db, fillsHistoryStore),
            store: reconcileStore,
            healer: new MongoHealer(db),
            alerter: {
                notify: async ({ cycleId, count }) =>
                    logger.warn({ cycleId, majorFindings: count }, "reconcile: open major findings — operator review needed"),
            },
            valuePositionsGbp,
            thresholds: {
                positionDriftSharesAuto:  env.RECONCILE_POSITION_AUTO_SHARES,
                positionDriftSharesAlert: env.RECONCILE_POSITION_ALERT_SHARES,
                cashDriftAlertAmount:     env.RECONCILE_CASH_ALERT_GBP,
            },
            autoHealEnabled: env.RECONCILE_AUTO_HEAL,
        });
        reconcile = {
            run: (w) => engine.run(w),
            acknowledge: (findingId, by) => reconcileStore.markResolution(findingId, 'operator_acknowledged', by),
            listFindings: (openOnly, limit) => reconcileStore.listFindings(openOnly, limit),
            listNav: (limit) => reconcileStore.listNav(limit),
            listFills: (f) => fillsHistoryStore.listFills(f),
        };
    }

    return {
        logger,
        env,
        sharedClient,
        sharedAccountCache,
        signal,
        fillsPoller,
        dispatcher,
        reconcile,
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
