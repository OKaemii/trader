// Route-level tests for GET /internal/api/universe/sectors.
//
// Pinning:
//   - Only the 'strategy-engine' internal-token caller is accepted (defence in depth)
//   - Response shape matches contracts/src/universe/schemas.ts InternalSectorsResponseSchema
//   - Tickers without a Mongo row fall back to 'Unknown'
//   - fetchedAt is the max Mongo `fetchedAt` across the returned rows
//
// Mongo is mocked at the @trader/shared-mongo boundary so the test is hermetic.
process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect, vi } from 'vitest';

const NOW = Date.UTC(2026, 4, 19, 14, 0);

const stubMetaRows: Array<{ _id: string; sector: string; source: string; fetchedAt: Date }> = [
  { _id: 'AAPL_US_EQ', sector: 'Technology', source: 'yahoo',  fetchedAt: new Date(NOW - 24 * 3600_000) },
  { _id: 'SHELl_EQ',   sector: 'Energy',     source: 'yahoo',  fetchedAt: new Date(NOW - 48 * 3600_000) },
];

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: {
    INSTRUMENT_METADATA: 'instrument_metadata',
    OHLCV_BARS:          'ohlcv_bars',
  },
  getMongoDb: async () => ({
    collection: () => ({
      find: (filter: any) => {
        const inSet = new Set<string>(filter?._id?.$in ?? []);
        const list = stubMetaRows.filter((r) => inSet.has(r._id));
        return {
          project: () => ({ toArray: async () => list }),
          toArray: async () => list,
        };
      },
      findOne: async () => null,
      countDocuments: async () => 0,
    }),
  }),
}));

vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({ get: async () => null, setEx: async () => 'OK' }),
}));

const { Hono } = await import('hono');
const { mintInternalJwt } = await import('@trader/shared-auth');
const { createInternalBarsRouter } = await import('../modules/admin/routes.ts');

const stubUM = {
  activeTickers: ['AAPL_US_EQ', 'SHELl_EQ', 'NEW_US_EQ'],   // NEW has no row → 'Unknown'
  sectorMap: {},
  refresh: async () => [],
};

function buildApp() {
  const app = new Hono();
  app.route('/', createInternalBarsRouter(stubUM as never));
  return app;
}

const strategyToken = async () => `Bearer ${await mintInternalJwt('strategy-engine')}`;
const gatewayToken  = async () => `Bearer ${await mintInternalJwt('api-gateway')}`;

describe('GET /internal/api/universe/sectors', () => {
  it('rejects no-token requests with 401', async () => {
    const res = await buildApp().request('/internal/api/universe/sectors');
    expect(res.status).toBe(401);
  });

  it('rejects the api-gateway caller — strategy-engine only', async () => {
    const res = await buildApp().request('/internal/api/universe/sectors', {
      headers: { Authorization: await gatewayToken() },
    });
    expect(res.status).toBe(403);
  });

  it('returns one entry per active ticker, mapping missing tickers to "Unknown"', async () => {
    const res = await buildApp().request('/internal/api/universe/sectors', {
      headers: { Authorization: await strategyToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { sectors: Record<string, string>; fetchedAt: number };
    expect(body.sectors).toEqual({
      AAPL_US_EQ: 'Technology',
      SHELl_EQ:   'Energy',
      NEW_US_EQ:  'Unknown',
    });
  });

  it('fetchedAt is the max timestamp across returned rows', async () => {
    const res = await buildApp().request('/internal/api/universe/sectors', {
      headers: { Authorization: await strategyToken() },
    });
    const body = await res.json() as { fetchedAt: number };
    // The freshest stub row is AAPL_US_EQ at NOW - 24h.
    expect(body.fetchedAt).toBe(NOW - 24 * 3600_000);
  });
});
