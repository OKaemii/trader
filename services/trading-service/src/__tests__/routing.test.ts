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
process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect, beforeAll } from "vitest";
import { buildApp, type AppDeps } from '../index.ts';
import { AccountCache } from '../modules/orders/infrastructure/AccountCache.ts';
import { mintInternalJwt, signAccessToken } from '@trader/shared-auth';
import { TradingMode } from '../modules/orders/domain/Order.ts';

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
// Cash is Money-shaped (GBP) to match the production T212Client contract post-FX work.
function makeT212() {
  return {
    getCash:      async () => ({
      free:  { amount: 1000, currency: 'GBP' as const },
      total: { amount: 1000, currency: 'GBP' as const },
    }),
    getPositions: async () => [] as unknown[],
    getPortfolio:    () => { throw new Error('unused in tests'); },
    placeLimitOrder: () => { throw new Error('unused in tests'); },
    placeMarketOrder:() => { throw new Error('unused in tests'); },
    listActiveOrders:() => { throw new Error('unused in tests'); },
  } as never;
}

function paperDeps(): AppDeps {
  return {
    tradingMode: TradingMode.Paper,
    getRedis: async () => makeRedis(),
    getDb:    async () => { throw new Error('db should not be needed in paper-mode routing tests'); },
    client:   () => makeT212(),
  };
}

// /admin/api/* is gated by parseAdminHeaders — each service is its own auth perimeter
// and verifies the end-user's JWT directly (portal sends it through nginx-ingress).
// /internal/api/* uses parseInternalHeaders with per-route caller pinning.
let adminJWT:    string;
let userJWT:     string;

beforeAll(async () => {
  adminJWT = await signAccessToken({ sub: 'admin-user',   role: 'admin' });
  userJWT  = await signAccessToken({ sub: 'regular-user', role: 'user'  });   // wrong-aud fixture
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
  describe('/admin/api/trading/* (admin user JWT)', () => {
    it('returns 200 on /status with an admin user JWT', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/admin/api/trading/status', {
        headers: { Authorization: `Bearer ${adminJWT}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // mode is serialised as the enum member name (TradingMode[Paper]) for portal readability.
      expect(body).toEqual({ trading_mode: 'Paper', live_gate_approved: false });
    });

    it('returns 200 on /orders with an admin user JWT', async () => {
      const deps: AppDeps = {
        ...paperDeps(),
        getDb: async () => ({
          collection: () => ({
            find:  () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }),
          }),
        }) as never,
      };
      const app = buildApp(deps);
      const res = await app.request('/admin/api/trading/orders', {
        headers: { Authorization: `Bearer ${adminJWT}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 on /status with no auth header', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/admin/api/trading/status');
      expect(res.status).toBe(401);
    });

    it('returns 403 on /status with a non-admin user JWT', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/admin/api/trading/status', {
        headers: { Authorization: `Bearer ${userJWT}` },
      });
      expect(res.status).toBe(403);
    });
  });

  describe('/internal/trading/* (portfolio-service caller)', () => {
    it('returns 200 on /cash with the portfolio-service internal token', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/cash', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('portfolio-service')}` },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 on /cash with no auth header', async () => {
      // Phase 4: requireInternal returns 401 (no token) rather than the legacy 403.
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/cash');
      expect(res.status).toBe(401);
    });

    it('returns 200 on /cash with the signal-service token — AutoApprovalGate cash pro-rate path', async () => {
      // /internal/api/trading/cash deliberately accepts BOTH portfolio-service AND signal-service
      // callers — signal-service hits it during AutoApprovalGate.process to scale BUY weights
      // to fit free cash. See requirePortfolioOrSignal wiring in index.ts.
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/cash', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('signal-service')}` },
      });
      expect(res.status).toBe(200);
    });

    it('short-circuits to GBP zero in Paper mode (parity with the admin /cash route)', async () => {
      // Paper deployments place no orders, so the internal cash read must not hit the broker —
      // it returns a real Money(0,'GBP') exactly like /admin/api/trading/cash. Without parity,
      // the admin route reads £0 while RiskEngine reads a live broker figure in a paper mode.
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/cash', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('signal-service')}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        free:  { amount: 0, currency: 'GBP' },
        total: { amount: 0, currency: 'GBP' },
      });
    });

    it('returns the live broker cash in non-Paper mode (Demo hits getCash / AccountCache)', async () => {
      // Guards the short-circuit from over-reaching: in Demo it must still return the real
      // T212 figure, not the paper zero.
      const app = buildApp({ ...paperDeps(), tradingMode: TradingMode.Demo });
      const res = await app.request('/internal/api/trading/cash', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('signal-service')}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        free:  { amount: 1000, currency: 'GBP' },
        total: { amount: 1000, currency: 'GBP' },
      });
    });

    it('returns 403 on /cash when the caller in the token is neither portfolio nor signal', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/cash', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('trading-service')}` },
      });
      expect(res.status).toBe(403);
    });
  });

  // Regression for the deploy-time bug: /internal/api/trading/cash and /positions called
  // deps.client() directly per request, bypassing the AccountCache the dispatcher uses.
  // Result: portfolio-service polls + signal-service AutoApprovalGate bursts hit T212
  // independently of the dispatcher and burst past T212's rate limit. The fix threads
  // a shared AccountCache through deps so all callers coalesce on one cached read.
  describe('AccountCache shared with HTTP routes', () => {
    function countingClient() {
      let cashCalls = 0;
      let posCalls  = 0;
      const client = {
        getCash:      async () => { cashCalls++; return {
          free:  { amount: 500,  currency: 'GBP' as const },
          total: { amount: 1500, currency: 'GBP' as const },
        }; },
        getPositions: async () => { posCalls++;  return [{
          ticker: 'AAPL_US_EQ', quantity: 5,
          averagePrice: { amount: 100, currency: 'USD' as const },
          currentPrice: { amount: 110, currency: 'USD' as const },
          currentValue: { amount: 550, currency: 'USD' as const },
        }]; },
        getPortfolio:    () => { throw new Error('unused'); },
        placeLimitOrder: () => { throw new Error('unused'); },
        placeMarketOrder:() => { throw new Error('unused'); },
        listActiveOrders:() => { throw new Error('unused'); },
      } as never;
      return { client, get cashCalls() { return cashCalls; }, get posCalls() { return posCalls; } };
    }

    it('serves /cash from the AccountCache, coalescing concurrent requests onto ONE T212 call', async () => {
      const cc = countingClient();
      const accountCache = new AccountCache(cc.client as any, { ttlMs: 60_000 });
      // Demo mode: the AccountCache path is only exercised in non-Paper modes (Paper
      // short-circuits to GBP zero before the broker read — parity with the admin route).
      const app = buildApp({
        ...paperDeps(),
        tradingMode: TradingMode.Demo,
        client: () => cc.client,
        accountCache,
      });

      // Three concurrent /cash requests — without coalescing this would be 3 T212 hits.
      const results = await Promise.all([
        app.request('/internal/api/trading/cash', { headers: { Authorization: `Bearer ${await mintInternalJwt('portfolio-service')}` } }),
        app.request('/internal/api/trading/cash', { headers: { Authorization: `Bearer ${await mintInternalJwt('portfolio-service')}` } }),
        app.request('/internal/api/trading/cash', { headers: { Authorization: `Bearer ${await mintInternalJwt('signal-service')}` } }),
      ]);
      for (const r of results) expect(r.status).toBe(200);
      const bodies = await Promise.all(results.map((r) => r.json()));
      for (const body of bodies) expect(body).toEqual({
        free:  { amount: 500,  currency: 'GBP' },
        total: { amount: 1500, currency: 'GBP' },
      });

      // The whole point: ONE T212 fetch despite three callers.
      expect(cc.cashCalls).toBe(1);
    });

    it('serves /positions from the AccountCache (positions field of the same snapshot)', async () => {
      const cc = countingClient();
      const accountCache = new AccountCache(cc.client as any, { ttlMs: 60_000 });
      const app = buildApp({
        ...paperDeps(),
        tradingMode: TradingMode.Demo,
        client: () => cc.client,
        accountCache,
      });

      const res = await app.request('/internal/api/trading/positions', {
        headers: { Authorization: `Bearer ${await mintInternalJwt('portfolio-service')}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0].ticker).toBe('AAPL_US_EQ');
      // First-touch fetched both cash and positions; subsequent /positions would coalesce.
      expect(cc.posCalls).toBe(1);
    });
  });

  describe('/internal/api/trading/execute (signal-service caller)', () => {
    const body = JSON.stringify({
      signalId: 'test-1', ticker: 'AAPL_US_EQ', action: 'BUY', targetWeight: 0.01, confidence: 0.5,
    });

    it('returns 200 skipped/deprecated — signals now flow through the order-dispatcher queue', async () => {
      // The synchronous execute path was retired when the queue + dispatcher landed.
      // The endpoint remains for backwards compatibility with old callers; it always
      // returns {skipped:true} so a stale signal-service that still POSTs here doesn't
      // hard-fail. New signals enter the dispatcher via lifecycle='queued', not here.
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/execute', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await mintInternalJwt('signal-service')}`, 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status).toBe(200);
      const payload = await res.json();
      expect(payload.skipped).toBe(true);
      expect(payload.reason).toMatch(/deprecated/i);
    });

    it('returns 403 with the portfolio-service token (wrong caller)', async () => {
      const app = buildApp(paperDeps());
      const res = await app.request('/internal/api/trading/execute', {
        method: 'POST',
        headers: { Authorization: `Bearer ${await mintInternalJwt('portfolio-service')}`, 'Content-Type': 'application/json' },
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
