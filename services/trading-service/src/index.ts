import { Hono } from 'hono';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { requireAuth, requireRole, requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb } from '@trader/shared-mongo';
import { getRedisClient, subscribe } from '@trader/shared-redis';
import { Trading212Client } from './infrastructure/t212.ts';
import { MongoOrderRepository } from './infrastructure/MongoOrderRepository.ts';
import { T212OrderExecutor } from './infrastructure/T212OrderExecutor.ts';
import { PlaceOrderUseCase } from './application/use-cases/PlaceOrderUseCase.ts';
import { FillsPoller } from './application/services/FillsPoller.ts';
import { AccountCache } from './infrastructure/account-cache.ts';
import { OrderDispatcher } from './infrastructure/order-dispatcher.ts';
import { getSignalOrderType, invalidateSignalOrderType } from './infrastructure/live-config.ts';
import { TradingMode, parseTradingMode } from './domain/entities/Order.ts';
import { money, BASE_CURRENCY } from '@trader/shared-types';
import { FxClient, YahooFxProvider } from '@trader/shared-fx';

// Live-trading admin approval gate. Stored in Redis so it survives restarts (intentional:
// prevents accidental live trading after a reboot without deliberate re-approval).
const LIVE_GATE_KEY = 'trading:live_approved';

export interface AppDeps {
  tradingMode: TradingMode;
  getRedis: () => Promise<Pick<RedisClientType, 'get' | 'set' | 'del'>>;
  getDb:    () => Promise<Db>;
  client:   () => Trading212Client;
  // Shared AccountCache for `/internal/trading/cash` and `/internal/trading/positions`.
  // Optional so the existing test deps (paper mode) keep working — when omitted, the
  // routes fall back to direct T212 calls. Production wiring at the bottom of this
  // file constructs one cache for both the dispatcher and the HTTP routes.
  accountCache?: AccountCache;
}

// Wire format for the `mode` field returned on HTTP responses — keep the member name
// (Paper/Demo/Live) rather than the integer so the portal can render it without a
// reverse-lookup table. The internal type is the enum.
const modeName = (m: TradingMode) => TradingMode[m];

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { tradingMode } = deps;

  app.get('/health', (c) => c.json({ status: 'ok', trading_mode: modeName(tradingMode) }));

  // Internal routes use per-route `requireInternalToken` rather than `subapp.use('*', mw)` +
  // `app.route('/', subapp)`. The subapp+wildcard pattern bleeds the middleware onto every
  // subsequent route on the parent app (see __tests__/routing.test.ts), which previously
  // turned every non-/health request into a 403.
  const requirePortfolio = requireInternalToken('portfolio-service');
  const requireSignal    = requireInternalToken('signal-service');
  // /internal/trading/cash is also called by signal-service for the auto-approve cash
  // pro-rate pass (compute scale = freeCash / totalBuyNotional before approving signals).
  const requirePortfolioOrSignal = requireInternalToken('portfolio-service', 'signal-service');

  // Both routes serve from AccountCache when one is configured. Coalesces concurrent
  // callers (portfolio-service polling + signal-service AutoApprovalGate) onto a single
  // T212 fetch, and serves stale-fallback on 429 — without this, the two services'
  // independent poll cadences burst past T212's rate limit and every cycle 429s.
  app.get('/internal/trading/positions', requirePortfolio, async (c) => {
    if (deps.accountCache) {
      const snap = await deps.accountCache.get();
      return c.json({ positions: snap.positions });
    }
    const positions = await deps.client().getPositions();
    return c.json({ positions });
  });

  app.get('/internal/trading/cash', requirePortfolioOrSignal, async (c) => {
    if (deps.accountCache) {
      const snap = await deps.accountCache.get();
      return c.json({ free: snap.free, total: snap.total });
    }
    const cash = await deps.client().getCash();
    return c.json(cash);
  });

  // Legacy synchronous execute path. The order-dispatcher loop now owns signal → T212
  // routing via the durable queue; this endpoint exists only for backwards compatibility
  // with any caller still posting here. New callers should put signals on the queue
  // (signal-service ApproveSignal flips lifecycle to 'queued') instead.
  app.post('/internal/signals/trading/execute', requireSignal, async (c) => {
    return c.json({
      skipped: true,
      reason:  'deprecated — signals are now routed through the order-dispatcher queue. Approve via signal-service to enqueue.',
    }, 200);
  });

  // Admin routes. Middleware is mounted on a path prefix on the main app (not via a
  // wildcard subapp) so it cannot bleed onto unrelated routes — see the routing test for
  // the regression this prevents.
  app.use('/api/admin/*', requireAuth, requireRole('admin'));
  const admin = app;

  admin.post('/api/admin/trading/toggle', (c) => {
    return c.json({
      mode: modeName(tradingMode),
      message: 'Change TRADING_MODE env var and redeploy to switch modes',
    });
  });

  admin.post('/api/admin/trading/approve-live', async (c) => {
    if (tradingMode !== TradingMode.Live) {
      return c.json({ error: 'TRADING_MODE is not set to Live — change in Helm values and redeploy first' }, 400);
    }
    const redis = await deps.getRedis();
    await redis.set(LIVE_GATE_KEY, '1');
    console.warn('[TradingService] LIVE TRADING APPROVED by admin — real orders will now be placed');
    return c.json({ approved: true, message: 'Live trading gate opened. Real T212 orders will be placed on next signal.' });
  });

  admin.post('/api/admin/trading/revoke-live', async (c) => {
    const redis = await deps.getRedis();
    await redis.del(LIVE_GATE_KEY);
    console.warn('[TradingService] Live trading approval REVOKED by admin');
    return c.json({ approved: false, message: 'Live trading gate closed.' });
  });

  admin.get('/api/admin/trading/status', async (c) => {
    const redis = await deps.getRedis();
    const approved = !!(await redis.get(LIVE_GATE_KEY));
    return c.json({ trading_mode: modeName(tradingMode), live_gate_approved: approved });
  });

  admin.post('/api/admin/trading/execute', async (c) => {
    const body = await c.req.json<{
      signalId: string;
      ticker: string;
      action: 'BUY' | 'SELL';
      targetWeight: number;
      confidence: number;
      totalNAV?:     { amount: number; currency: 'GBP' | 'USD' };
      currentPrice?: { amount: number; currency: 'GBP' | 'USD' };
      currentQuantity?: number;
    }>();

    // Hono doesn't validate against the TS type at runtime. Reject legacy raw-scalar
    // bodies up-front rather than letting them silently produce a 100x sizing error.
    if (body.totalNAV !== undefined &&
        (typeof body.totalNAV.amount !== 'number' || !body.totalNAV.currency)) {
      return c.json({ message: 'totalNAV must be { amount, currency }' }, 400);
    }
    if (body.currentPrice !== undefined &&
        (typeof body.currentPrice.amount !== 'number' || !body.currentPrice.currency)) {
      return c.json({ message: 'currentPrice must be { amount, currency }' }, 400);
    }

    const db    = await deps.getDb();
    const redis = await deps.getRedis();

    const orderRepo = new MongoOrderRepository(db);
    const executor  = new T212OrderExecutor(deps.client());
    const liveApproved = async () => !!(await redis.get(LIVE_GATE_KEY));

    const useCase = new PlaceOrderUseCase(orderRepo, executor, liveApproved, getSignalOrderType);
    const order   = await useCase.execute(body);

    if (!order) {
      return c.json({ message: 'Order skipped — check TRADING_MODE, live gate, currency match' }, 200);
    }
    return c.json({ order });
  });

  admin.get('/api/admin/trading/orders', async (c) => {
    const db        = await deps.getDb();
    const orderRepo = new MongoOrderRepository(db);
    const orders    = await orderRepo.findRecent(50);
    return c.json({ orders });
  });

  // Admin-facing reads of T212 state. Used by the portal dashboard. In paper mode the
  // T212 client isn't authenticated, so we return an empty payload instead of erroring —
  // the portal renders "no broker connection" rather than 500.
  admin.get('/api/admin/trading/cash', async (c) => {
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
      return c.json({ error: e instanceof Error ? e.message : 'cash fetch failed', mode: modeName(tradingMode) }, 502);
    }
  });

  admin.get('/api/admin/trading/positions', async (c) => {
    if (tradingMode === TradingMode.Paper) {
      return c.json({ positions: [], mode: modeName(tradingMode) });
    }
    try {
      const positions = await deps.client().getPositions();
      return c.json({ positions, mode: modeName(tradingMode) });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'positions fetch failed', mode: modeName(tradingMode) }, 502);
    }
  });

  return app;
}

function productionClient(): Trading212Client {
  const mode = parseTradingMode(process.env.TRADING_MODE);
  const isLive = mode === TradingMode.Live;
  const key   = isLive ? (process.env.T212_API_KEY    ?? '') : (process.env.T212_API_KEY_DEMO    ?? '');
  const keyId = isLive ? (process.env.T212_API_KEY_ID ?? '') : (process.env.T212_API_KEY_ID_DEMO ?? '');
  return new Trading212Client(key, keyId);
}

// Production wiring — only runs when this file is the process entrypoint (not when imported by tests).
const tradingMode = parseTradingMode(process.env.TRADING_MODE);

const FILL_POLL_INTERVAL_MS = parseInt(process.env.FILL_POLL_INTERVAL_MS ?? '30000', 10);

// Dispatcher knobs — defaults are conservative for `daily` mode. See CLAUDE.md.
const ORDER_MIN_INTERVAL_MS   = parseInt(process.env.ORDER_MIN_INTERVAL_MS   ?? '1100',     10);
const ORDER_MAX_ATTEMPTS      = parseInt(process.env.ORDER_MAX_ATTEMPTS      ?? '5',        10);
const QUEUE_TTL_MS            = parseInt(process.env.QUEUE_TTL_MS            ?? '3600000',  10); // 1h
const ACCOUNT_CACHE_TTL_MS    = parseInt(process.env.ACCOUNT_CACHE_TTL_MS    ?? '30000',    10);
const PRICE_DRIFT_TOLERANCE   = parseFloat(process.env.PRICE_DRIFT_TOLERANCE ?? '0.01');         // 1%
const SIGNAL_SERVICE_URL      = process.env.SIGNAL_SERVICE_URL ?? 'http://signal-service:3003';

// One AccountCache instance for the whole process. Shared between:
//   - HTTP routes /internal/trading/{cash,positions}  (portfolio-service + signal-service callers)
//   - OrderDispatcher's per-signal cash/positions reads
// Without this sharing, portfolio-service's poll cadence + AutoApprovalGate's bursts +
// the dispatcher's own reads each hit T212 independently and burst past the rate limit.
const sharedClient       = productionClient();
const sharedAccountCache = new AccountCache(sharedClient, { ttlMs: ACCOUNT_CACHE_TTL_MS });

// FxClient is lazy-singleton: built on first use against the shared Redis. Used by
// the dispatcher to convert GBP NAV → instrument currency before sizing each order.
let _fxClient: FxClient | null = null;
async function getFxClient(): Promise<FxClient> {
  if (_fxClient) return _fxClient;
  const redis = await getRedisClient();
  _fxClient = new FxClient(redis as any, new YahooFxProvider());
  return _fxClient;
}

const productionDeps: AppDeps = {
  tradingMode,
  getRedis: () => getRedisClient() as unknown as Promise<Pick<RedisClientType, 'get' | 'set' | 'del'>>,
  getDb:    () => getMongoDb(),
  client:   () => sharedClient,
  accountCache: sharedAccountCache,
};
const app = buildApp(productionDeps);

if (import.meta.main) {
  (async () => {
    if (tradingMode !== TradingMode.Paper) {
      const db = await getMongoDb();
      const orderRepo = new MongoOrderRepository(db);
      new FillsPoller(orderRepo, sharedClient, FILL_POLL_INTERVAL_MS).start();
      console.log(`[trading-service] fills poller started (${FILL_POLL_INTERVAL_MS}ms, mode=${modeName(tradingMode)})`);
    }

    const dispatcher = new OrderDispatcher({
      signalServiceUrl:    SIGNAL_SERVICE_URL,
      tradingMode,
      client:              sharedClient,
      accountCache:        sharedAccountCache,
      getDb:               () => getMongoDb(),
      getRedis:            () => getRedisClient() as unknown as Promise<Pick<RedisClientType, 'get'>>,
      fxFromGBP:           async (amount, target) => (await getFxClient()).fromGBP(amount, target),
      minIntervalMs:       ORDER_MIN_INTERVAL_MS,
      maxAttempts:         ORDER_MAX_ATTEMPTS,
      queueTtlMs:          QUEUE_TTL_MS,
      priceDriftTolerance: PRICE_DRIFT_TOLERANCE,
    });

    // Boot sweep: any signals stuck at lifecycle='executing' from a prior pod that
    // crashed mid-flight get reverted to 'queued' so the new dispatcher picks them up.
    // FillsPoller is the source of truth for whether the order actually reached T212;
    // PlaceOrderUseCase's findBySignalId guard prevents duplicate placement.
    try {
      const reverted = await dispatcher.sweepStaleExecuting(60_000);
      if (reverted > 0) console.warn(`[trading-service] boot sweep reverted ${reverted} stale executing signal(s)`);
    } catch (e) {
      console.warn('[trading-service] boot sweep failed (signal-service likely not up yet):', e);
    }

    dispatcher.start().catch((e) => console.error('[trading-service] dispatcher crashed:', e));

    // Subscribe to portal config-invalidated pubsub so a Save in the portal drops our
    // live-config cache within the round-trip rather than waiting up to 15s for the TTL.
    // Topic name is hard-coded to avoid pulling a market-data-service export into a peer
    // service — kept in sync via the comment in admin-routes.ts CONFIG_INVALIDATED_TOPIC.
    try {
      const redis = await getRedisClient();
      await subscribe(redis as unknown as RedisClientType, 'config:invalidated', () => {
        invalidateSignalOrderType();
        console.log('[trading-service] live-config cache invalidated via pubsub');
      });
    } catch (err) {
      console.warn('[trading-service] config-invalidated subscribe failed (TTL still applies):', err);
    }
  })().catch((e) => console.error('[trading-service] bootstrap failed:', e));
}

// idleTimeout raised from the Bun default (10s) so synchronous order-placement chains
// involving T212 calls (which can stall on 429s or network) don't get reset mid-flight.
export default { port: 3005, idleTimeout: 60, fetch: app.fetch };
