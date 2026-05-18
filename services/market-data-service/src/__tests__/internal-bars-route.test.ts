// Route-level tests for the strategy-engine-facing /internal/bars endpoints.
//
// Pinning the contract strategy-engine depends on:
//   - Only the 'strategy-engine' internal-token caller is accepted (defence in depth)
//   - GET returns one ticker's bars, downsampled to the requested interval
//   - POST returns a {ticker: bars[]} map, batched in one round-trip
//   - Invalid interval / range → 400 BEFORE touching Mongo
//   - Empty tickers[] → empty map (no error, no Mongo touch)
//
// Mongo + Redis + the shared-bars getBars call are mocked. Hermetic test, no network.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi } from "vitest";

// Stub Mongo: every collection.find returns three 5m bars for any ticker, sorted oldest-first.
// We use this to verify that aggregation to 'daily' yields ONE bar per ticker (all three 5m
// bars fold into the same UTC day) — proving the endpoint downsamples via aggregateBars.
const fiveMin = 5 * 60_000;
const dayStart = Date.UTC(2026, 4, 14, 0, 0, 0);
const stubDocs = (ticker: string) => [
  { ticker, timestamp: new Date(dayStart),                 interval: '5m', open: 100, high: 102, low: 99,  close: 101, volume: 10 },
  { ticker, timestamp: new Date(dayStart + fiveMin),        interval: '5m', open: 101, high: 103, low: 100, close: 102, volume: 20 },
  { ticker, timestamp: new Date(dayStart + 2 * fiveMin),    interval: '5m', open: 102, high: 105, low: 101, close: 104, volume: 30 },
];

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: {
    OHLCV_BARS:                 'ohlcv_bars',
    PORTAL_MARKET_CONFIG:       'portal_market_config',
    PORTAL_UNIVERSE_OVERRIDES:  'portal_universe_overrides',
    INSTRUMENT_REGISTRY:        'instrument_registry',
    BAD_TICKS:                  'bad_ticks',
  },
  getMongoDb: async () => ({
    collection: () => ({
      find: (q: any) => ({
        sort: () => ({
          toArray: async () => stubDocs(q.ticker),
        }),
      }),
      findOne: async () => null,
      countDocuments: async () => 0,
    }),
    listCollections: () => ({ toArray: async () => [] }),
  }),
}));

vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({
    get:   async () => null,    // force cache miss so we exercise the Mongo path
    setEx: async () => 'OK',
    del:   async () => 0,
    publish: async () => 0,
  }),
  xAdd: async () => '',
  ensureConsumerGroup: async () => {},
}));

const { Hono } = await import('hono');
const { mintInternalJwt } = await import('@trader/shared-auth');
const { createInternalBarsRouter } = await import('../admin-routes.ts');

function buildApp() {
  const app = new Hono();
  app.route('/', createInternalBarsRouter());
  return app;
}

const strategyToken = async () => `Bearer ${await mintInternalJwt('strategy-engine')}`;
const gatewayToken = async () => `Bearer ${await mintInternalJwt('api-gateway')}`;

describe('GET /internal/bars/:ticker', () => {
  it('rejects no-token requests with 401', async () => {
    const res = await buildApp().request('/internal/bars/AAPL_US_EQ?interval=daily&range=30d');
    expect(res.status).toBe(401);
  });

  it('rejects the api-gateway caller — strategy-engine only', async () => {
    const res = await buildApp().request('/internal/bars/AAPL_US_EQ?interval=daily&range=30d', {
      headers: { Authorization: await gatewayToken() },
    });
    expect(res.status).toBe(403);
  });

  it('returns bars downsampled to the requested interval (3×5m → 1 daily)', async () => {
    const res = await buildApp().request('/internal/bars/AAPL_US_EQ?interval=daily&range=30d', {
      headers: { Authorization: await strategyToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL_US_EQ');
    expect(body.interval).toBe('daily');
    expect(body.range).toBe('30d');
    // All three stub 5m bars fold into a single UTC day, so we expect ONE daily bar.
    expect(body.bars).toHaveLength(1);
    // Aggregation invariants: open=first, close=last, high=max, low=min, volume=sum.
    expect(body.bars[0].open).toBe(100);
    expect(body.bars[0].close).toBe(104);
    expect(body.bars[0].high).toBe(105);
    expect(body.bars[0].low).toBe(99);
    expect(body.bars[0].volume).toBe(60);
  });

  it('400 on invalid interval', async () => {
    const res = await buildApp().request('/internal/bars/AAPL_US_EQ?interval=bogus&range=30d', {
      headers: { Authorization: await strategyToken() },
    });
    expect(res.status).toBe(400);
  });

  it('400 on invalid range', async () => {
    const res = await buildApp().request('/internal/bars/AAPL_US_EQ?interval=daily&range=bogus', {
      headers: { Authorization: await strategyToken() },
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/bars (batch)', () => {
  it('rejects no-token requests with 401', async () => {
    const res = await buildApp().request('/internal/bars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: ['AAPL_US_EQ'] }),
    });
    expect(res.status).toBe(401);
  });

  it('returns a {ticker: bars[]} map for multiple tickers', async () => {
    const res = await buildApp().request('/internal/bars', {
      method: 'POST',
      headers: { Authorization: await strategyToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: ['AAPL_US_EQ', 'MSFT_US_EQ'], interval: 'daily', range: '30d' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interval).toBe('daily');
    expect(body.range).toBe('30d');
    expect(Object.keys(body.bars).sort()).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(body.bars.AAPL_US_EQ).toHaveLength(1);
    expect(body.bars.MSFT_US_EQ).toHaveLength(1);
  });

  it('returns empty map for empty tickers[] without erroring', async () => {
    const res = await buildApp().request('/internal/bars', {
      method: 'POST',
      headers: { Authorization: await strategyToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: [] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bars).toEqual({});
  });

  it('defaults to interval=daily, range=30d when omitted', async () => {
    const res = await buildApp().request('/internal/bars', {
      method: 'POST',
      headers: { Authorization: await strategyToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: ['AAPL_US_EQ'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interval).toBe('daily');
    expect(body.range).toBe('30d');
  });
});

// Regression: when both routers are mounted on the same app (production wiring in
// services/market-data-service/src/index.ts), the admin router's path-scoped middleware
// MUST NOT bleed onto the internal-bars routes. A previous version used `r.use('*', mw)`
// on the admin subapp, which Hono propagates to every later-registered route on the
// PARENT app — making /internal/bars 403 because it expected caller='strategy-engine' but
// the bled middleware demanded caller='api-gateway'. This test fails if that pattern returns.
describe('admin + internal-bars on the same app (mounting regression)', () => {
  it('strategy-engine token is accepted on /internal/bars when both routers are mounted', async () => {
    const { createAdminRouter } = await import('../admin-routes.ts');
    const { YahooProvider } = await import('../providers/yahoo-provider.ts');
    const stubUM: any = { activeTickers: [], sectorMap: {}, refresh: async () => [] };

    const app = new Hono();
    // Admin first, then internal — same order as production wiring (index.ts).
    const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => noopLog, level: 'info' } as never;
    app.route('/', createAdminRouter(stubUM, new YahooProvider(), noopLog));
    app.route('/', createInternalBarsRouter());

    const res = await app.request('/internal/bars', {
      method: 'POST',
      headers: { Authorization: await strategyToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: [] }),
    });
    expect(res.status).toBe(200);
  });
});
