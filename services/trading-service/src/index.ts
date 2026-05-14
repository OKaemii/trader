import { Hono } from 'hono';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import { requireAuth, requireRole, requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { Trading212Client } from './infrastructure/t212.ts';
import { MongoOrderRepository } from './infrastructure/MongoOrderRepository.ts';
import { T212OrderExecutor } from './infrastructure/T212OrderExecutor.ts';
import { PlaceOrderUseCase } from './application/use-cases/PlaceOrderUseCase.ts';
import { FillsPoller } from './application/services/FillsPoller.ts';
import { AccountCache } from './infrastructure/account-cache.ts';
import { OrderDispatcher } from './infrastructure/order-dispatcher.ts';

export type TradingMode = 'paper' | 'demo' | 'live';

// Live-trading admin approval gate. Stored in Redis so it survives restarts (intentional:
// prevents accidental live trading after a reboot without deliberate re-approval).
const LIVE_GATE_KEY = 'trading:live_approved';

export interface AppDeps {
  tradingMode: TradingMode;
  getRedis: () => Promise<Pick<RedisClientType, 'get' | 'set' | 'del'>>;
  getDb:    () => Promise<Db>;
  client:   () => Trading212Client;
}

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  const { tradingMode } = deps;

  app.get('/health', (c) => c.json({ status: 'ok', trading_mode: tradingMode }));

  // Internal routes use per-route `requireInternalToken` rather than `subapp.use('*', mw)` +
  // `app.route('/', subapp)`. The subapp+wildcard pattern bleeds the middleware onto every
  // subsequent route on the parent app (see __tests__/routing.test.ts), which previously
  // turned every non-/health request into a 403.
  const requirePortfolio = requireInternalToken('portfolio-service');
  const requireSignal    = requireInternalToken('signal-service');
  // /internal/trading/cash is also called by signal-service for the auto-approve cash
  // pro-rate pass (compute scale = freeCash / totalBuyNotional before approving signals).
  const requirePortfolioOrSignal = requireInternalToken('portfolio-service', 'signal-service');

  app.get('/internal/trading/positions', requirePortfolio, async (c) => {
    const positions = await deps.client().getPositions();
    return c.json({ positions });
  });

  app.get('/internal/trading/cash', requirePortfolioOrSignal, async (c) => {
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
      mode: tradingMode,
      message: 'Change TRADING_MODE env var and redeploy to switch modes',
    });
  });

  admin.post('/api/admin/trading/approve-live', async (c) => {
    if (tradingMode !== 'live') {
      return c.json({ error: 'TRADING_MODE is not set to live — change in Helm values and redeploy first' }, 400);
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
    return c.json({ trading_mode: tradingMode, live_gate_approved: approved });
  });

  admin.post('/api/admin/trading/execute', async (c) => {
    const body = await c.req.json<{
      signalId: string;
      ticker: string;
      action: 'BUY' | 'SELL';
      targetWeight: number;
      confidence: number;
      totalNAV?: number;
      currentPrice?: number;
      currentQuantity?: number;
    }>();

    const db    = await deps.getDb();
    const redis = await deps.getRedis();

    const orderRepo = new MongoOrderRepository(db);
    const executor  = new T212OrderExecutor(deps.client());
    const liveApproved = async () => !!(await redis.get(LIVE_GATE_KEY));

    const useCase = new PlaceOrderUseCase(orderRepo, executor, liveApproved);
    const order   = await useCase.execute(body);

    if (!order) {
      return c.json({ message: 'Order skipped — check TRADING_MODE and live gate status' }, 200);
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
    if (tradingMode === 'paper') {
      return c.json({ free: 0, total: 0, mode: tradingMode });
    }
    try {
      const cash = await deps.client().getCash();
      return c.json({ ...cash, mode: tradingMode });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'cash fetch failed', mode: tradingMode }, 502);
    }
  });

  admin.get('/api/admin/trading/positions', async (c) => {
    if (tradingMode === 'paper') {
      return c.json({ positions: [], mode: tradingMode });
    }
    try {
      const positions = await deps.client().getPositions();
      return c.json({ positions, mode: tradingMode });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'positions fetch failed', mode: tradingMode }, 502);
    }
  });

  return app;
}

function productionClient(): Trading212Client {
  const isLive = process.env.TRADING_MODE === 'live';
  const key   = isLive ? (process.env.T212_API_KEY    ?? '') : (process.env.T212_API_KEY_DEMO    ?? '');
  const keyId = isLive ? (process.env.T212_API_KEY_ID ?? '') : (process.env.T212_API_KEY_ID_DEMO ?? '');
  return new Trading212Client(key, keyId);
}

// Production wiring — only runs when this file is the process entrypoint (not when imported by tests).
const tradingMode = (process.env.TRADING_MODE ?? 'paper') as TradingMode;
const productionDeps: AppDeps = {
  tradingMode,
  getRedis: () => getRedisClient() as unknown as Promise<Pick<RedisClientType, 'get' | 'set' | 'del'>>,
  getDb:    () => getMongoDb(),
  client:   productionClient,
};
const app = buildApp(productionDeps);

const FILL_POLL_INTERVAL_MS = parseInt(process.env.FILL_POLL_INTERVAL_MS ?? '30000', 10);

// Dispatcher knobs — defaults are conservative for `daily` mode. See CLAUDE.md.
const ORDER_MIN_INTERVAL_MS   = parseInt(process.env.ORDER_MIN_INTERVAL_MS   ?? '1100',     10);
const ORDER_MAX_ATTEMPTS      = parseInt(process.env.ORDER_MAX_ATTEMPTS      ?? '5',        10);
const QUEUE_TTL_MS            = parseInt(process.env.QUEUE_TTL_MS            ?? '3600000',  10); // 1h
const ACCOUNT_CACHE_TTL_MS    = parseInt(process.env.ACCOUNT_CACHE_TTL_MS    ?? '30000',    10);
const PRICE_DRIFT_TOLERANCE   = parseFloat(process.env.PRICE_DRIFT_TOLERANCE ?? '0.01');         // 1%
const SIGNAL_SERVICE_URL      = process.env.SIGNAL_SERVICE_URL ?? 'http://signal-service:3003';

if (import.meta.main) {
  (async () => {
    if (tradingMode !== 'paper') {
      const db = await getMongoDb();
      const orderRepo = new MongoOrderRepository(db);
      new FillsPoller(orderRepo, productionClient(), FILL_POLL_INTERVAL_MS).start();
      console.log(`[trading-service] fills poller started (${FILL_POLL_INTERVAL_MS}ms, mode=${tradingMode})`);
    }

    // Order-dispatcher loop runs in ALL modes including paper — in paper it drains the
    // queue by marking signals as executed without calling T212 (see dispatcher code).
    const client       = productionClient();
    const accountCache = new AccountCache(client, { ttlMs: ACCOUNT_CACHE_TTL_MS });
    const dispatcher = new OrderDispatcher({
      signalServiceUrl:    SIGNAL_SERVICE_URL,
      tradingMode,
      client,
      accountCache,
      getDb:               () => getMongoDb(),
      getRedis:            () => getRedisClient() as unknown as Promise<Pick<RedisClientType, 'get'>>,
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
  })().catch((e) => console.error('[trading-service] bootstrap failed:', e));
}

// idleTimeout raised from the Bun default (10s) so synchronous order-placement chains
// involving T212 calls (which can stall on 429s or network) don't get reset mid-flight.
export default { port: 3005, idleTimeout: 60, fetch: app.fetch };
