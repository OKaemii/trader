// Per-symbol Research Fundamentals tab data path (research-trading-os Task 27):
//   GET /admin/api/market-data/fundamentals/:ticker  → stored QMJ line items + ratios + market cap
//   (peek; no provider walk) PLUS analyst estimates (currently the stubbed null placeholder —
//   decision I, the Yahoo source was dropped). The analyst block is additive: a null must leave the
//   stored line items rendering. Plus the StubAnalystEstimates placeholder (always null).

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi } from 'vitest';

// shared-mongo is reached only by FundamentalsCache, which we stub below — but the router module
// graph pulls it in transitively, so provide a no-op.
vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { COMPANY_FUNDAMENTALS: 'company_fundamentals' },
  getMongoDb: async () => ({ collection: () => ({ find: () => ({ toArray: async () => [] }) }) }),
}));

const { Hono } = await import('hono');
const { signAccessToken } = await import('@trader/shared-auth');
const { createFundamentalsRouter } = await import('../modules/fundamentals/routes.ts');
const { StubAnalystEstimates } = await import('../modules/fundamentals/infrastructure/StubAnalystEstimates.ts');
import type { FundamentalsCache, FundamentalsDoc } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { UniverseManager } from '../modules/universe/application/UniverseManager.ts';
import type { FundamentalsRefreshScheduler } from '../modules/fundamentals/application/FundamentalsRefreshScheduler.ts';
import type { AnalystEstimatesFetcher } from '../modules/fundamentals/routes.ts';

const adminToken = async () => `Bearer ${await signAccessToken({ sub: 'admin-user', role: 'admin' })}`;

const SAMPLE_DOC: FundamentalsDoc = {
  _id: 'AAPL_US_EQ',
  asOf: 1_700_000_000_000,
  raw: { netIncome: 100, totalEquity: 500, totalDebt: 200, currentAssets: 300, currentLiabilities: 150, marketCapGbp: 2_000_000 },
  ratios: { roe: 0.2, debtToEquity: 0.4, currentRatio: 2.0 },
  qualityPass: true,
  marketCapGbp: 2_000_000,
  source: 'yahoo',
  updatedAt: 1_700_000_000_000,
};

function buildApp(opts: {
  peek?: (tickers: string[]) => Promise<Record<string, FundamentalsDoc>>;
  analyst?: AnalystEstimatesFetcher;
} = {}) {
  const cache = {
    peek: opts.peek ?? (async (tickers: string[]) =>
      Object.fromEntries(tickers.filter((t) => t === SAMPLE_DOC._id).map((t) => [t, SAMPLE_DOC]))),
  } as unknown as FundamentalsCache;
  const universe = { activeTickers: [] as string[] } as unknown as UniverseManager;
  const refresher = { triggerNow: () => {} } as unknown as FundamentalsRefreshScheduler;
  const app = new Hono();
  app.route('/', createFundamentalsRouter(cache, universe, refresher, opts.analyst));
  return app;
}

describe('GET /admin/api/market-data/fundamentals/:ticker', () => {
  it('401s without an admin token', async () => {
    const res = await buildApp().request('/admin/api/market-data/fundamentals/AAPL_US_EQ');
    expect(res.status).toBe(401);
  });

  it('returns the stored line items, ratios, market cap, and source for a known ticker', async () => {
    const res = await buildApp().request('/admin/api/market-data/fundamentals/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL_US_EQ');
    expect(body.raw.netIncome).toBe(100);
    expect(body.ratios).toEqual({ roe: 0.2, debtToEquity: 0.4, currentRatio: 2.0 });
    expect(body.qualityPass).toBe(true);
    expect(body.marketCapGbp).toBe(2_000_000);
    expect(body.source).toBe('yahoo');
    expect(body.analyst).toBeNull(); // no analyst fetcher wired in this case
  });

  it('returns nulls (not a fabricated 0) for a ticker with no cached row', async () => {
    const res = await buildApp().request('/admin/api/market-data/fundamentals/ZZZZ_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.raw).toBeNull();
    expect(body.ratios).toBeNull();
    expect(body.qualityPass).toBeNull();
    expect(body.marketCapGbp).toBeNull();
  });

  it('does NOT let the :ticker param capture the coverage/refresh literal paths', async () => {
    // coverage is its own route (200); a /:ticker capture would have hit cache.peek(['coverage']).
    const peek = vi.fn(async () => ({}) as Record<string, FundamentalsDoc>);
    const cache = {
      peek,
      coverage: async () => ({ count: 0, passing: 0, oldestAsOf: null }),
    } as unknown as FundamentalsCache;
    const universe = { activeTickers: [] } as unknown as UniverseManager;
    const refresher = { triggerNow: () => {} } as unknown as FundamentalsRefreshScheduler;
    const app = new Hono();
    app.route('/', createFundamentalsRouter(cache, universe, refresher));
    const res = await app.request('/admin/api/market-data/fundamentals/coverage', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('count'); // coverage shape, not the per-ticker shape
    expect(peek).not.toHaveBeenCalled();
  });

  // The fetcher seam is preserved for a later PIT re-wire: a populated fetcher folds its estimates
  // in, and a fetcher that throws degrades the analyst block to null without failing the read of the
  // stored line items.
  it('folds in a populated fetcher and survives a fetcher that throws', async () => {
    const good: AnalystEstimatesFetcher = {
      fetch: async () => ({
        priceTargetLow: 150, priceTargetMean: 200, priceTargetHigh: 250, numberOfAnalysts: 30,
        recommendationMean: 1.8, recommendationKey: 'buy', recommendation: null,
        earningsGrowth: [], revenueGrowth: [],
      }),
    };
    const okRes = await buildApp({ analyst: good }).request('/admin/api/market-data/fundamentals/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect((await okRes.json()).analyst.priceTargetMean).toBe(200);

    const throwing: AnalystEstimatesFetcher = { fetch: async () => { throw new Error('provider down'); } };
    const res = await buildApp({ analyst: throwing }).request('/admin/api/market-data/fundamentals/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200); // stored line items still render
    const body = await res.json();
    expect(body.raw.netIncome).toBe(100);
    expect(body.analyst).toBeNull();
  });
});

// ── StubAnalystEstimates (placeholder) ──────────────────────────────────────────────────────────
// Analyst estimates are not yet available from a PIT source (decision I); the stub always returns
// null, which the route folds into the payload as `analyst: null` and the portal renders as a
// "PIT-sourced — coming soon" placeholder. The interface survives for a later PIT-backed provider.
describe('StubAnalystEstimates (placeholder)', () => {
  it('always returns null (estimates not yet available) for any ticker', async () => {
    const est = new StubAnalystEstimates();
    expect(await est.fetch('AAPL_US_EQ')).toBeNull();
    expect(await est.fetch('SHELl_EQ')).toBeNull();
    expect(await est.fetch('ANYTHING')).toBeNull();
  });

  it('satisfies the AnalystEstimatesFetcher seam (drops into the route unchanged)', async () => {
    const fetcher: AnalystEstimatesFetcher = new StubAnalystEstimates();
    const res = await buildApp({ analyst: fetcher }).request('/admin/api/market-data/fundamentals/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // stored line items still render; the analyst block is the null placeholder
    expect(body.raw.netIncome).toBe(100);
    expect(body.analyst).toBeNull();
  });
});
