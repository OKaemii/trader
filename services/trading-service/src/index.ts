import { Hono } from 'hono';
import { requireAuth, requireRole } from '@trader/shared-auth/middleware';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { getMongoDb } from '@trader/shared-mongo';
import { getRedisClient } from '@trader/shared-redis';
import { Trading212Client } from './infrastructure/t212.ts';
import { MongoOrderRepository } from './infrastructure/MongoOrderRepository.ts';
import { T212OrderExecutor } from './infrastructure/T212OrderExecutor.ts';
import { PlaceOrderUseCase } from './application/use-cases/PlaceOrderUseCase.ts';

const app = new Hono();
const TRADING_MODE = process.env.TRADING_MODE ?? 'paper';

// ── Live-trading admin approval gate ─────────────────────────────────────────
// Admin must call POST /api/admin/trading/approve-live after setting TRADING_MODE=live.
// Gate is stored in Redis so it survives restarts (intentional: prevents accidental live trading
// after a reboot without deliberate re-approval).
const LIVE_GATE_KEY = 'trading:live_approved';

function getClient(): Trading212Client {
  const isLive = process.env.TRADING_MODE === 'live';
  const key   = isLive ? (process.env.T212_API_KEY    ?? '') : (process.env.T212_API_KEY_DEMO    ?? '');
  const keyId = isLive ? (process.env.T212_API_KEY_ID ?? '') : (process.env.T212_API_KEY_ID_DEMO ?? '');
  return new Trading212Client(key, keyId);
}

// Internal: position sync used by portfolio-service
const internal = new Hono();
internal.use('*', requireInternalToken('portfolio-service'));

internal.get('/internal/trading/positions', async (c) => {
  const client = getClient();
  const positions = await client.getPositions();
  return c.json({ positions });
});

internal.get('/internal/trading/cash', async (c) => {
  const client = getClient();
  const cash = await client.getCash();
  return c.json(cash);
});

// Health must be registered before the internal router — internal's use('*') middleware
// intercepts all requests including /health if mounted first.
app.get('/health', (c) => c.json({ status: 'ok', trading_mode: TRADING_MODE }));
app.route('/', internal);


// Admin routes
const admin = new Hono();
admin.use('*', requireAuth, requireRole('admin'));

admin.post('/api/admin/trading/toggle', (c) => {
  return c.json({
    mode: TRADING_MODE,
    message: 'Change TRADING_MODE env var and redeploy to switch modes',
  });
});

// Live trading gate — admin must call this explicitly after setting TRADING_MODE=live
// Prerequisites (CLAUDE.md):
//   1. ValidationReport.passed = true from POST /api/admin/backtest/run
//   2. agent-docs/research/tda-economic-rationale.md Section 4 completed
//   3. This endpoint called (Step 22 admin gate)
admin.post('/api/admin/trading/approve-live', async (c) => {
  if (TRADING_MODE !== 'live') {
    return c.json({ error: 'TRADING_MODE is not set to live — change in Helm values and redeploy first' }, 400);
  }
  const redis = await getRedisClient();
  await redis.set(LIVE_GATE_KEY, '1');
  console.warn('[TradingService] LIVE TRADING APPROVED by admin — real orders will now be placed');
  return c.json({ approved: true, message: 'Live trading gate opened. Real T212 orders will be placed on next signal.' });
});

admin.post('/api/admin/trading/revoke-live', async (c) => {
  const redis = await getRedisClient();
  await redis.del(LIVE_GATE_KEY);
  console.warn('[TradingService] Live trading approval REVOKED by admin');
  return c.json({ approved: false, message: 'Live trading gate closed.' });
});

admin.get('/api/admin/trading/status', async (c) => {
  const redis = await getRedisClient();
  const approved = !!(await redis.get(LIVE_GATE_KEY));
  return c.json({ trading_mode: TRADING_MODE, live_gate_approved: approved });
});

// Admin: execute a specific signal as a live order (manual trigger for testing)
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

  const db    = await getMongoDb();
  const redis = await getRedisClient();

  const orderRepo = new MongoOrderRepository(db);
  const executor  = new T212OrderExecutor();
  const liveApproved = async () => !!(await redis.get(LIVE_GATE_KEY));

  const useCase = new PlaceOrderUseCase(orderRepo, executor, liveApproved);
  const order   = await useCase.execute(body);

  if (!order) {
    return c.json({ message: 'Order skipped — check TRADING_MODE and live gate status' }, 200);
  }
  return c.json({ order });
});

admin.get('/api/admin/trading/orders', async (c) => {
  const db        = await getMongoDb();
  const orderRepo = new MongoOrderRepository(db);
  const orders    = await orderRepo.findRecent(50);
  return c.json({ orders });
});

app.route('/', admin);

export default { port: 3005, fetch: app.fetch };
