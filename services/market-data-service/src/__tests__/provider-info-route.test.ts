// Route-level test for /api/admin/market-data/provider-info. The portal calls this
// once on mount to populate the poll-cadence dropdown — so the contract pinned here
// is what the FE depends on:
//   { name, maxLookbackMs, allowedPollIntervals: [{key,ms,label,tier}, ...] }
//
// We use the real YahooProvider so any drift between the interface declaration and
// the implementation (forgetting to declare allowedPollIntervals, mismatched key
// names) shows up immediately.

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, vi } from "vitest";

// Mock @trader/shared-mongo BEFORE importing the admin router, so the route's
// updateOne / findOne calls hit our in-memory stub instead of trying to reach a
// real MongoDB. live-config (cached) is also invalidated where needed via the
// module's exported helper.
const mongoStore = new Map<string, any>();
let updateOneCalls = 0;
vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: {
    PORTAL_MARKET_CONFIG:       'portal_market_config',
    PORTAL_UNIVERSE_OVERRIDES:  'portal_universe_overrides',
    OHLCV_BARS:                 'ohlcv_bars',
    INSTRUMENT_REGISTRY:        'instrument_registry',
    BAD_TICKS:                  'bad_ticks',
  },
  getMongoDb: async () => ({
    collection: (_name: string) => ({
      findOne: async (q: any) => mongoStore.get(JSON.stringify(q)) ?? null,
      updateOne: async (q: any, update: any, _opts: any) => {
        updateOneCalls++;
        mongoStore.set(JSON.stringify(q), { ...(update.$set ?? {}) });
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      },
      find:    () => ({ project: () => ({ toArray: async () => [] }), toArray: async () => [] }),
      bulkWrite: async () => ({ upsertedCount: 0, modifiedCount: 0 }),
      countDocuments: async () => 0,
      deleteMany: async () => ({ deletedCount: 0 }),
      aggregate:  () => ({ toArray: async () => [] }),
    }),
    listCollections: () => ({ toArray: async () => [] }),
  }),
}));

// Redis mock — admin routes touch it for cache invalidation pubsub. Only the methods
// we actually call need to exist. publishCalls captures (channel, payload) tuples so
// the executionMode test can assert the live-config invalidation fan-out without
// reaching into module internals.
const publishCalls: Array<{ channel: string; payload: string }> = [];
vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({
    get: async () => null,
    setEx: async () => 'OK',
    del: async () => 0,
    publish: async (channel: string, payload: string) => {
      publishCalls.push({ channel, payload });
      return 0;
    },
  }),
  xAdd: async () => '',
  ensureConsumerGroup: async () => {},
}));

const { Hono } = await import('hono');
const { generateInternalToken } = await import('@trader/shared-auth');
const { createAdminRouter } = await import('../admin-routes.ts');
const { YahooProvider } = await import('../providers/yahoo-provider.ts');

function buildApp() {
  const app = new Hono();
  // UniverseManager is required by the admin router. We hand it a minimal stub —
  // the provider-info route doesn't touch the universe manager at all.
  const stubUM: any = { activeTickers: [], refresh: async () => [] };
  app.route('/', createAdminRouter(stubUM, new YahooProvider()));
  return app;
}

const gatewayToken = () => generateInternalToken('api-gateway');

describe('GET /api/admin/market-data/provider-info', () => {
  it('requires the api-gateway internal token (403 without)', async () => {
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/provider-info');
    expect(res.status).toBe(403);
  });

  it('returns provider name, max lookback, and the allowed poll intervals', async () => {
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/provider-info', {
      headers: { 'X-Internal-Token': gatewayToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('yahoo');
    expect(body.maxLookbackMs).toBe(60 * 24 * 60 * 60_000);
    // Yahoo's allow-list: 15m / 1h / 24h. Order matters for the dropdown.
    const keys = body.allowedPollIntervals.map((o: any) => o.key);
    expect(keys).toEqual(['15m', '1h', '24h']);
    // Every option should have a tier (used for chip colour on the portal).
    for (const opt of body.allowedPollIntervals) {
      expect(opt).toHaveProperty('ms');
      expect(opt).toHaveProperty('label');
      expect(['intraday', 'hourly', 'daily']).toContain(opt.tier);
    }
  });
});

describe('PUT /api/admin/market-data/config (allowlist enforcement)', () => {
  it('accepts pollIntervalMs values in the provider allowlist and persists them', async () => {
    const before = updateOneCalls;
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/config', {
      method: 'PUT',
      headers: { 'X-Internal-Token': gatewayToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollIntervalMs: 60 * 60_000 }),  // 1h, in Yahoo's list
    });
    expect(res.status).toBe(200);
    // Should have written to the mocked Mongo (real assertion that the route reached
    // the persist step, not just bailed on validation).
    expect(updateOneCalls).toBeGreaterThan(before);
  });

  it('rejects pollIntervalMs values outside the provider allowlist with 400 BEFORE writing to Mongo', async () => {
    const before = updateOneCalls;
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/config', {
      method: 'PUT',
      headers: { 'X-Internal-Token': gatewayToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ pollIntervalMs: 7000 }),  // 7s — not in any provider's list
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not allowed by provider/);
    expect(Array.isArray(body.allowed)).toBe(true);
    // Validation must reject BEFORE the Mongo write — no row should be touched.
    expect(updateOneCalls).toBe(before);
  });
});

describe('PUT /api/admin/market-data/config (signalOrderType hot-swap)', () => {
  it('persists signalOrderType=Market (1) and publishes the config-invalidated pubsub', async () => {
    publishCalls.length = 0;
    const before = updateOneCalls;
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/config', {
      method: 'PUT',
      headers: { 'X-Internal-Token': gatewayToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalOrderType: 1 }),  // OrderType.Market
    });
    expect(res.status).toBe(200);
    expect(updateOneCalls).toBe(before + 1);

    const stored = mongoStore.get(JSON.stringify({ _id: 'singleton' }));
    expect(stored?.signalOrderType).toBe(1);

    // The invalidation fan-out is what makes the hot-swap feel instant on the operator's
    // side — trading-service subscribes to this topic and drops its 15s cache when it fires.
    const invalidations = publishCalls.filter((p) => p.channel === 'config:invalidated');
    expect(invalidations.length).toBe(1);
    const payload = JSON.parse(invalidations[0].payload);
    expect(payload.signalOrderType).toBe(1);
  });

  it('rejects an out-of-enum signalOrderType value with 400 and does not persist', async () => {
    publishCalls.length = 0;
    const before = updateOneCalls;
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/config', {
      method: 'PUT',
      headers: { 'X-Internal-Token': gatewayToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalOrderType: 99 }),
    });
    expect(res.status).toBe(400);
    expect(updateOneCalls).toBe(before);
    expect(publishCalls.filter((p) => p.channel === 'config:invalidated').length).toBe(0);
  });

  it('accepts a save that explicitly clears signalOrderType (null = no override)', async () => {
    publishCalls.length = 0;
    const app = buildApp();
    const res = await app.request('/api/admin/market-data/config', {
      method: 'PUT',
      headers: { 'X-Internal-Token': gatewayToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalOrderType: null }),
    });
    expect(res.status).toBe(200);
    const stored = mongoStore.get(JSON.stringify({ _id: 'singleton' }));
    expect(stored?.signalOrderType).toBeNull();
    expect(publishCalls.filter((p) => p.channel === 'config:invalidated').length).toBe(1);
  });
});
