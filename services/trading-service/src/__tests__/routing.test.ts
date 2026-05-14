// Regression tests for the route/middleware wiring in `index.ts`.
//
// Background: A previous version registered the internal routes on a Hono subapp via
//   const internal = new Hono();
//   internal.use('*', requireInternalToken('portfolio-service'));
//   app.route('/', internal);
// When a wildcard-middleware'd subapp is mounted at '/', Hono applies that middleware to
// every subsequent route on the parent — so /api/admin/* and even unknown paths returned
// 403, and the signal-service auto-execute call was silently rejected. The fix uses
// per-route `requireInternalToken(caller)` instead. These tests assert the status codes
// that bug would regress.

// JWT_SECRET and INTERNAL_SECRET must be set before shared-auth modules are imported,
// because both read process.env lazily inside helper functions but tokens generated with
// one value won't validate against another. Pinning them keeps the test deterministic.
process.env.JWT_SECRET      = 'test-jwt-secret';
process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, beforeAll } from 'bun:test';
import { buildApp, type AppDeps } from '../index.ts';
import { signAccessToken } from '@trader/shared-auth/jwt';
import { generateInternalToken } from '@trader/shared-auth/internal-token';

// Minimal in-memory Redis stub — only the three methods the routes actually call.
function makeRedis() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); return 'OK' as const; },
    del: async (k: string) => { const had = store.delete(k); return had ? 1 : 0; },
  };
}

// Trading212Client stub. Returns enough shape for /cash and /positions; the execute path
// in paper mode short-circuits before touching it, so other methods can throw if hit.
function makeT212() {
  return {
    getCash:      async () => ({ free: 1000, total: 1000 }),
    getPositions: async () => [] as unknown[],
    getPortfolio:    () => { throw new Error('unused in tests'); },
    placeLimitOrder: () => { throw new Error('unused in tests'); },
    placeMarketOrder:() => { throw new Error('unused in tests'); },
    listActiveOrders:() => { throw new Error('unused in tests'); },
  } as never;
}

function paperDeps(): AppDeps {
  return {
    tradingMode: 'paper',
    getRedis: async () => makeRedis(),
    getDb:    async () => { throw new Error('db should not be needed in paper-mode routing tests'); },
    client:   () => makeT212(),
  };
}

let adminJWT: string;
let userJWT:  string;

beforeAll(async () => {
  adminJWT = await signAccessToken({ sub: 'admin-user', role: 'admin' });
  userJWT  = await signAccessToken({ sub: 'regular-user', role: 'user' });
});

describe('trading-service routing', () => {
  describe('GET /health (no auth)', () => {
    it('returns 200', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/health');
      expect(res.status).toBe(200);
    });
  });

  // ── Admin routes. The regression bug returned 403 here because internal-subapp wildcard
  // middleware bled onto the admin path. These tests catch that regression.
  describe('/api/admin/trading/* (JWT, admin role)', () => {
    it('returns 200 on /status with an admin JWT', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/api/admin/trading/status', {
        headers: { Authorization: `Bearer ${adminJWT}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ trading_mode: 'paper', live_gate_approved: false });
    });

    it('returns 200 on /orders with an admin JWT', async () => {
      // /orders touches the db — give it a stub repo via a minimal db that satisfies
      // MongoOrderRepository.findRecent. Easier: use a deps that returns a fake "db" whose
      // .collection().find().sort().limit().toArray() resolves to []. We bypass that here
      // by short-circuiting at the route boundary — assert status, not body content.
      const deps: AppDeps = {
        ...paperDeps(),
        getDb: async () => ({
          collection: () => ({
            find:  () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
          }),
        }) as never,
      };
      const app = buildApp(deps);
      const res = await app.request('/api/admin/trading/orders', {
        headers: { Authorization: `Bearer ${adminJWT}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 on /status with no auth header', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/api/admin/trading/status');
      expect(res.status).toBe(401);
    });

    it('returns 403 on /status with a non-admin JWT', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/api/admin/trading/status', {
        headers: { Authorization: `Bearer ${userJWT}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('/internal/trading/* (portfolio-service caller)', () => {
    it('returns 200 on /cash with the portfolio-service internal token', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/trading/cash', {
        headers: { 'X-Internal-Token': generateInternalToken('portfolio-service') },
      });
      expect(res.status).toBe(200);
    });

    it('returns 403 on /cash with no internal token', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/trading/cash');
      expect(res.status).toBe(403);
    });

    it('returns 403 on /cash when the caller in the token is wrong', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/trading/cash', {
        headers: { 'X-Internal-Token': generateInternalToken('signal-service') },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('/internal/signals/trading/execute (signal-service caller)', () => {
    const body = JSON.stringify({
      signalId: 'test-1', ticker: 'AAPL_US_EQ', action: 'BUY', targetWeight: 0.01, confidence: 0.5,
    });

    it('returns 200 in paper mode with the signal-service internal token', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/signals/trading/execute', {
        method: 'POST',
        headers: { 'X-Internal-Token': generateInternalToken('signal-service'), 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.skipped).toBe(true);
      expect(payload.reason).toBe('TRADING_MODE=paper');
    });

    it('returns 403 with the portfolio-service token (wrong caller)', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/signals/trading/execute', {
        method: 'POST',
        headers: { 'X-Internal-Token': generateInternalToken('portfolio-service'), 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(403);
    });
  });

  // The wildcard-subapp bug caused unknown routes to return 403 (the bleed middleware
  // ran before route matching). Hono's default for an unmatched path is 404 — a 403 here
  // would mean the regression is back.
  describe('unknown route', () => {
    it('returns 404, not 403', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/this-route-does-not-exist');
      expect(res.status).toBe(404);
    });
  });
});
