import { Hono } from 'hono';
import { requireAuth, requireRole } from '@trader/shared-auth/middleware';
import { requireInternalToken } from '@trader/shared-auth/middleware';
import { Trading212Client } from './infrastructure/t212.ts';

const app = new Hono();
const TRADING_MODE = process.env.TRADING_MODE ?? 'paper';

function getClient(): Trading212Client {
  const key = process.env.T212_API_KEY ?? '';
  return new Trading212Client(key);
}

// Internal: position sync used by portfolio-service
const internal = new Hono();
internal.use('*', requireInternalToken('api-gateway'));

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

app.route('/', internal);

// Admin: toggle trading mode
const admin = new Hono();
admin.use('*', requireAuth, requireRole('admin'));

admin.post('/api/admin/trading/toggle', (c) => {
  return c.json({
    mode: TRADING_MODE,
    message: 'Change TRADING_MODE env var and redeploy to switch modes',
  });
});

app.route('/', admin);
app.get('/health', (c) => c.json({ status: 'ok', trading_mode: TRADING_MODE }));

export default { port: 3005, fetch: app.fetch };
