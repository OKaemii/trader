import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { upgradeWebSocket } from 'hono/bun';
import { getRedisClient, subscribe } from '@trader/shared-redis';
import { requireAuth, requireRole, generateInternalToken } from '@trader/shared-auth';

const app = new Hono();

app.use('*', cors({ origin: ['http://trader.local', 'http://localhost:3007'] }));

// ── Internal token helper ────────────────────────────────────────────────────
function withInternalHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set('X-Internal-Token', generateInternalToken('api-gateway'));
  out.delete('Authorization'); // don't forward user tokens downstream
  return out;
}

async function proxy(upstream: string, c: any): Promise<Response> {
  const path = c.req.path;
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const url = `${upstream}${path}${qs}`;
  return fetch(url, {
    method: c.req.method,
    headers: withInternalHeaders(new Headers(c.req.raw.headers)),
    body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  });
}

// ── PUBLIC routes (no auth) ──────────────────────────────────────────────────
app.get('/health', (c) => c.json({ status: 'ok', ts: Date.now() }));
app.post('/api/auth/login',    (c) => proxy('http://auth-service:3001', c));
app.post('/api/auth/register', (c) => proxy('http://auth-service:3001', c));
app.post('/api/auth/refresh',  (c) => proxy('http://auth-service:3001', c));
app.get('/api/market/live',    (c) => proxy('http://market-data-service:3002', c));

// ── AUTHENTICATED routes (valid JWT, any role) ───────────────────────────────
const authed = new Hono();
authed.use('*', requireAuth);

authed.get('/api/signals',       (c) => proxy('http://signal-service:3003', c));
authed.get('/api/signals/:id',   (c) => proxy('http://signal-service:3003', c));
authed.get('/api/portfolio',     (c) => proxy('http://portfolio-service:3006', c));
authed.get('/api/portfolio/pnl', (c) => proxy('http://portfolio-service:3006', c));

// WebSocket: topology feature stream (auth via query param for WS handshake)
authed.get('/ws/topology', upgradeWebSocket(async (_c) => {
  let cleanup: (() => void) | undefined;
  return {
    async onOpen(_, ws) {
      const redis = await getRedisClient();
      cleanup = await subscribe(redis, 'strategy:dashboard', (p) => ws.send(JSON.stringify(p)));
    },
    onClose() { cleanup?.(); },
  };
}));

app.route('/', authed);

// ── ADMIN routes (JWT with role: admin) ──────────────────────────────────────
const admin = new Hono();
admin.use('*', requireAuth, requireRole('admin'));

admin.get('/api/admin/signals/history',       (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/signals/approve/:id',  (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/trading/toggle',             (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/approve-live',       (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/revoke-live',        (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/status',              (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/execute',            (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/orders',              (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/users',                 (c) => proxy('http://auth-service:3001', c));
admin.get('/api/admin/risk/status',                   (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/risk/circuit-breaker/reset',   (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/backtest/run',                 (c) => proxy('http://backtest-engine:8001', c));
admin.get('/api/admin/backtest/results',              (c) => proxy('http://backtest-engine:8001', c));
admin.get('/api/admin/system/health', async (c) => {
  const services = [
    ['auth',          'http://auth-service:3001/health'],
    ['market-data',   'http://market-data-service:3002/health'],
    ['strategy',      'http://strategy-engine:8000/health'],
    ['signals',       'http://signal-service:3003/health'],
    ['notifications', 'http://notification-service:3004/health'],
    ['trading',       'http://trading-service:3005/health'],
    ['portfolio',     'http://portfolio-service:3006/health'],
    ['backtest',      'http://backtest-engine:8001/health'],
  ] as const;
  const token = generateInternalToken('api-gateway');
  const results = await Promise.allSettled(
    services.map(async ([name, url]) => {
      const r = await fetch(url, { headers: { 'X-Internal-Token': token } });
      return { name, ok: r.ok, status: r.status };
    }),
  );
  return c.json(results.map((r) => r.status === 'fulfilled' ? r.value : { name: 'unknown', ok: false }));
});

app.route('/', admin);

export default { port: 3000, fetch: app.fetch };
