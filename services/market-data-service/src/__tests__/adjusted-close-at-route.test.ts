// Route-level tests for POST /internal/api/market-data/adjusted-close-at — the OOM-safe input
// fundamentals-api's PIT market-cap enrichment reads instead of the range='max' bars batch.
//
// The load-bearing contract:
//   - fundamentals-api IS an allowed internal caller (the cross-service trap: a 403 here is a 500
//     to the user when enrichment runs — invisible to the pure market_cap unit tests). strategy-engine
//     is allowed too; api-gateway is NOT; no token → 401.
//   - returns { closes: { ticker: number|null } } — the close of the single latest daily bar at/<=
//     asOf, with null for a ticker that has no qualifying bar (fail-closed → market cap absent).
//   - invalid body → 400 before touching Mongo.
//
// Mongo + Redis + the shared-bars getBarAtOrBefore call are mocked. Hermetic, no network.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi } from 'vitest';

// The mocked daily series, keyed on the bare identity `symbol|market` (storage is keyed on those two
// columns now). AAPL has bars, ZZZZ has none (→ null close, the fail-closed path).
const dayStart = Date.UTC(2026, 4, 14, 0, 0, 0);
const dailyByIdentity: Record<string, Array<Record<string, unknown>>> = {
  'AAPL|US': [
    { symbol: 'AAPL', market: 'US', observation_ts: dayStart - 86_400_000, knowledge_ts: dayStart - 86_400_000, interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 150, volume: 1 },
    { symbol: 'AAPL', market: 'US', observation_ts: dayStart,              knowledge_ts: dayStart,              interval: 'daily', is_superseded: false, open: 1, high: 1, low: 1, close: 175, volume: 1 },
  ],
  'ZZZZ|US': [],
};

// Minimal find().sort().limit().toArray() over the per-identity daily series — enough for
// getBarAtOrBefore's live mongo path. Picks the newest by the sort spec, slices to the limit.
vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { OHLCV_BARS: 'ohlcv_bars' },
  getMongoDb: async () => ({
    collection: () => ({
      find: (q: { symbol: string; market: string; interval?: string }) => {
        const rows = (q.interval === 'daily' ? dailyByIdentity[`${q.symbol}|${q.market}`] ?? [] : []).slice();
        let limitN: number | null = null;
        const cursor: { sort: (s: Record<string, number>) => typeof cursor; limit: (n: number) => typeof cursor; toArray: () => Promise<Array<Record<string, unknown>>> } = {
          sort: (s: Record<string, number>) => {
            const [k, dir] = Object.entries(s)[0] ?? ['observation_ts', -1];
            rows.sort((a, b) => ((a[k] as number) > (b[k] as number) ? 1 : -1) * dir);
            return cursor;
          },
          limit: (n: number) => { limitN = n; return cursor; },
          toArray: async () => (limitN != null ? rows.slice(0, limitN) : rows),
        };
        return cursor;
      },
    }),
  }),
}));

vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({
    get:   async () => null,    // force a miss → exercise the Mongo path
    setEx: async () => 'OK',
    del:   async () => 0,
    publish: async () => 0,
  }),
  xAdd: async () => '',
  ensureConsumerGroup: async () => {},
}));

const { Hono } = await import('hono');
const { mintInternalJwt } = await import('@trader/shared-auth');
const { createInternalBarsRouter } = await import('../modules/admin/routes.ts');

const stubUM: { activeTickers: string[]; sectorMap: Record<string, string>; refresh: () => Promise<string[]> } = {
  activeTickers: [],
  sectorMap: {},
  refresh: async () => [],
};

function buildApp() {
  const app = new Hono();
  app.route('/', createInternalBarsRouter(stubUM as never));
  return app;
}

const fundamentalsToken = async () => `Bearer ${await mintInternalJwt('fundamentals-api')}`;
const strategyToken     = async () => `Bearer ${await mintInternalJwt('strategy-engine')}`;
const gatewayToken      = async () => `Bearer ${await mintInternalJwt('api-gateway')}`;

const body = (tickers: string[]) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tickers, interval: 'daily' }),
});

describe('POST /internal/api/market-data/adjusted-close-at — auth allowlist', () => {
  it('rejects a no-token request with 401', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', body(['AAPL_US_EQ']));
    expect(res.status).toBe(401);
  });

  it('ACCEPTS the fundamentals-api caller (the cross-service contract — a 403 here is a 500 to the user)', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', {
      ...body(['AAPL_US_EQ']),
      headers: { Authorization: await fundamentalsToken(), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('accepts the strategy-engine caller too', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', {
      ...body(['AAPL_US_EQ']),
      headers: { Authorization: await strategyToken(), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects the api-gateway caller with 403', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', {
      ...body(['AAPL_US_EQ']),
      headers: { Authorization: await gatewayToken(), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /internal/api/market-data/adjusted-close-at — payload', () => {
  it('returns the close of the latest daily bar per ticker, null when none', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', {
      ...body(['AAPL_US_EQ', 'ZZZZ_US_EQ']),
      headers: { Authorization: await fundamentalsToken(), 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.interval).toBe('daily');
    expect(json.asOf).toBeNull();
    // AAPL → newest daily close (175); ZZZZ has no bars → null (fail-closed → market cap absent).
    expect(json.closes.AAPL_US_EQ).toBe(175);
    expect(json.closes.ZZZZ_US_EQ).toBeNull();
  });

  it('400 on a malformed body (empty-string ticker)', async () => {
    const res = await buildApp().request('/internal/api/market-data/adjusted-close-at', {
      method: 'POST',
      headers: { Authorization: await fundamentalsToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickers: [''] }),
    });
    expect(res.status).toBe(400);
  });
});
