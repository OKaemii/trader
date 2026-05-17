import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { getRedisClient, subscribe } from '@trader/shared-redis';
import { getMongoDb } from '@trader/shared-mongo';
import { requireAuth, requireRole, generateInternalToken, verifyAccessToken } from '@trader/shared-auth';

const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

app.use('*', cors({ origin: ['http://trader.local', 'http://localhost:3007'] }));

// ── Internal token helper ────────────────────────────────────────────────────
// Keep the user's Authorization header intact when forwarding — downstream services use
// `requireAuth` on user-facing routes and validate the same JWT. Cookies are forwarded too
// (the same JWT can also arrive as the `at` cookie). The X-Internal-Token attests that the
// request came through the gateway and unlocks `requireInternalToken('api-gateway')` routes.
function withInternalHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.set('X-Internal-Token', generateInternalToken('api-gateway'));
  return out;
}

async function proxy(upstream: string, c: any): Promise<Response> {
  const path = c.req.path;
  const qs = c.req.url.includes('?') ? '?' + c.req.url.split('?')[1] : '';
  const url = `${upstream}${path}${qs}`;
  const hasBody = !['GET', 'HEAD'].includes(c.req.method);
  // Node's fetch (undici) rejects streamed request bodies without `duplex: 'half'`. Bun was
  // looser. Read the body into a Buffer up front so the body is plain bytes and undici won't
  // complain about half-duplex streaming.
  const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
  const upstreamRes = await fetch(url, {
    method: c.req.method,
    headers: withInternalHeaders(new Headers(c.req.raw.headers)),
    body,
  });
  // Hono's downstream cors middleware mutates `c.res.headers` via Context.header(). Returning
  // a raw fetch Response here gives Hono an immutable-headered response that cors then crashes
  // on with "TypeError: immutable". Instead, hand the body bytes back through `c.body(...)`
  // which constructs a fresh Hono response with mutable headers, then copy across status +
  // content-type so the consumer sees the same wire payload.
  const responseBody = await upstreamRes.arrayBuffer();
  const contentType = upstreamRes.headers.get('content-type');
  if (contentType) c.header('content-type', contentType);
  c.status(upstreamRes.status as 200);
  return c.body(responseBody);
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

authed.get('/api/signals',          (c) => proxy('http://signal-service:3003', c));
// Specific path must come before the :id catch-all so it isn't shadowed.
authed.get('/api/signals/progress', (c) => proxy('http://signal-service:3003', c));
authed.get('/api/signals/:id',      (c) => proxy('http://signal-service:3003', c));
authed.get('/api/portfolio',     (c) => proxy('http://portfolio-service:3006', c));
authed.get('/api/portfolio/pnl', (c) => proxy('http://portfolio-service:3006', c));

// WebSocket: topology feature stream — auth via ?token= query param (browsers can't set headers on WS)
app.get('/ws/topology', upgradeWebSocket(async (c) => {
  const token = c.req.query('token');
  if (!token) {
    return { onOpen(_, ws) { ws.close(1008, 'Unauthorized'); } };
  }
  try {
    await verifyAccessToken(token);
  } catch {
    return { onOpen(_, ws) { ws.close(1008, 'Invalid token'); } };
  }
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
admin.post('/api/admin/signals/retry/:id',    (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/signals/cancel/:id',   (c) => proxy('http://signal-service:3003', c));
admin.get('/api/admin/signals/auto-approve',  (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/signals/auto-approve', (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/trading/toggle',             (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/approve-live',       (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/revoke-live',        (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/status',              (c) => proxy('http://trading-service:3005', c));
admin.post('/api/admin/trading/execute',            (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/orders',              (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/cash',                (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/trading/positions',           (c) => proxy('http://trading-service:3005', c));
admin.get('/api/admin/users',                 (c) => proxy('http://auth-service:3001', c));
admin.get('/api/admin/risk/status',                   (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/risk/circuit-breaker/reset',   (c) => proxy('http://signal-service:3003', c));
admin.post('/api/admin/backtest/run',                 (c) => proxy('http://backtest-engine:8001', c));
admin.get('/api/admin/backtest/results',              (c) => proxy('http://backtest-engine:8001', c));
admin.get('/api/admin/universe/overrides',            (c) => proxy('http://market-data-service:3002', c));
admin.put('/api/admin/universe/overrides',            (c) => proxy('http://market-data-service:3002', c));
admin.post('/api/admin/universe/refresh',             (c) => proxy('http://market-data-service:3002', c));
admin.get('/api/admin/market-data/config',            (c) => proxy('http://market-data-service:3002', c));
admin.put('/api/admin/market-data/config',            (c) => proxy('http://market-data-service:3002', c));
admin.post('/api/admin/market-data/backfill',         (c) => proxy('http://market-data-service:3002', c));
admin.post('/api/admin/market-data/clear-cache',      (c) => proxy('http://market-data-service:3002', c));
admin.get('/api/admin/market-data/bars/:ticker',      (c) => proxy('http://market-data-service:3002', c));
admin.get('/api/admin/market-data/coverage',          (c) => proxy('http://market-data-service:3002', c));
// market-data /health surfaces next_poll_ts + universe size etc. proxy() rewrites the
// request path 1:1 to the upstream, so to hit the upstream's /health we forward to a
// direct fetch. The portal needs the full payload (not just OK/error) to render the
// next-poll countdown.
admin.get('/api/admin/market-data/health', async (c) => {
  const r = await fetch('http://market-data-service:3002/health');
  const body = await r.text();
  return new Response(body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/json' } });
});
admin.get('/api/admin/market-data/provider-info',     (c) => proxy('http://market-data-service:3002', c));
// Session calendar routes — see agent-docs/plans/session-aware-polling-gate.md.
admin.get('/api/admin/market-data/calendar',          (c) => proxy('http://market-data-service:3002', c));
admin.get('/api/admin/market-data/holiday-sources',   (c) => proxy('http://market-data-service:3002', c));
admin.post('/api/admin/market-data/holiday-refresh',  (c) => proxy('http://market-data-service:3002', c));
admin.get('/api/admin/system/status', async (c) => {
  const token = generateInternalToken('api-gateway');
  const headers = { 'X-Internal-Token': token };
  const [marketRes, strategyRes] = await Promise.allSettled([
    fetch('http://market-data-service:3002/health', { headers }).then(r => r.json()),
    fetch('http://strategy-engine:8000/status',     { headers }).then(r => r.json()),
  ]);
  return c.json({
    market_data: marketRes.status === 'fulfilled' ? marketRes.value : { error: 'unavailable' },
    strategy:    strategyRes.status === 'fulfilled' ? strategyRes.value : { error: 'unavailable' },
  });
});

// System reset — wipes trading history + strategy state to start fresh from today.
// Drops: signals, ohlcv_bars, orders, positions, backtest_results, instrument_registry,
//        topology_snapshots, strategy_health_log, model_versions, feature_importance_log,
//        risk_state, risk_rejections, bad_ticks.
// Preserves: users, portal_universe_overrides, portal_market_config.
// Clears Redis: market:raw + signals:strategy streams; strategy:* / trading:live_approved
// / signal:auto_approve / regime warm-up keys. Requires a typed confirmation phrase to
// guard against accidental clicks. Real T212 broker state is NOT touched (external).
admin.post('/api/admin/system/reset', async (c) => {
  const body = await c.req.json<{ confirm?: string }>().catch(() => ({} as { confirm?: string }));
  if (body.confirm !== 'RESET') {
    return c.json({ error: 'confirmation phrase mismatch (expected "RESET")' }, 400);
  }

  const result: Record<string, number | string> = {};
  try {
    const db = await getMongoDb();
    const wipe = [
      'signals', 'ohlcv_bars', 'orders', 'positions', 'backtest_results',
      'instrument_registry', 'topology_snapshots', 'strategy_health_log',
      'model_versions', 'feature_importance_log', 'risk_state', 'risk_rejections',
      'bad_ticks',
    ];
    for (const name of wipe) {
      const r = await db.collection(name).deleteMany({});
      result[`mongo.${name}`] = r.deletedCount ?? 0;
    }

    const redis = await getRedisClient();
    // Streams: hard-trim to length 0. Consumer-group offsets are preserved (xtrim doesn't
    // touch them); next consumer read just finds an empty stream.
    try { await redis.sendCommand(['XTRIM', 'market:raw',       'MAXLEN', '0']); result['redis.stream.market:raw'] = 'trimmed'; }
    catch (e) { result['redis.stream.market:raw'] = `error: ${(e as Error).message}`; }
    try { await redis.sendCommand(['XTRIM', 'signals:strategy', 'MAXLEN', '0']); result['redis.stream.signals:strategy'] = 'trimmed'; }
    catch (e) { result['redis.stream.signals:strategy'] = `error: ${(e as Error).message}`; }

    // State keys: scan + delete by prefix. Falls back gracefully if any prefix doesn't exist.
    const prefixes = ['strategy:', 'regime:', 'trading:', 'signal:auto_approve'];
    for (const p of prefixes) {
      const pattern = p.endsWith(':') ? `${p}*` : p;
      try {
        const keys: string[] = [];
        for await (const k of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          if (Array.isArray(k)) keys.push(...k);
          else keys.push(k);
        }
        if (keys.length > 0) await redis.del(keys);
        result[`redis.keys.${p}`] = keys.length;
      } catch (e) {
        result[`redis.keys.${p}`] = `error: ${(e as Error).message}`;
      }
    }

    console.warn('[system/reset] state wiped:', result);
    return c.json({ ok: true, result, note: 'T212 broker holdings are external and unchanged. Restart pods to clear in-memory caches.' });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'reset failed', partial: result }, 500);
  }
});

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

const port = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api-gateway] listening on :${info.port}`);
});
injectWebSocket(server);
