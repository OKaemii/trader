// Per-symbol Research Fundamentals tab data path (research-trading-os Task 27):
//   GET /admin/api/market-data/fundamentals/:ticker  → stored QMJ line items + ratios + market cap
//   (peek; no provider walk) PLUS best-effort Yahoo analyst estimates (additive — may trail, §H).
// Plus the YahooAnalystEstimates extractor over a realistic quoteSummary shape (the parsing is the
// risk surface, and it must degrade to null on any error rather than break the stored-line-item read).

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
const { YahooAnalystEstimates } = await import('../modules/fundamentals/infrastructure/YahooAnalystEstimates.ts');
import type { FundamentalsCache, FundamentalsDoc } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { UniverseManager } from '../modules/universe/application/UniverseManager.ts';
import type { FundamentalsRefreshScheduler } from '../modules/fundamentals/application/FundamentalsRefreshScheduler.ts';
import type { AnalystEstimatesFetcher } from '../modules/fundamentals/routes.ts';
import type { QuoteSummaryFetcher } from '../modules/bars/infrastructure/providers/yahoo-quote-summary.ts';

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

  it('attaches best-effort analyst estimates and survives a fetcher that throws', async () => {
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

    const throwing: AnalystEstimatesFetcher = { fetch: async () => { throw new Error('yahoo down'); } };
    const res = await buildApp({ analyst: throwing }).request('/admin/api/market-data/fundamentals/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200); // stored line items still render
    const body = await res.json();
    expect(body.raw.netIncome).toBe(100);
    expect(body.analyst).toBeNull();
  });
});

// ── YahooAnalystEstimates extractor ─────────────────────────────────────────────────────────────
const QS_RESULT = {
  financialData: {
    targetLowPrice: { raw: 150.0 },
    targetMeanPrice: { raw: 200.5 },
    targetHighPrice: { raw: 260.0 },
    numberOfAnalystOpinions: { raw: 32 },
    recommendationMean: { raw: 1.9 },
    recommendationKey: 'buy',
  },
  recommendationTrend: {
    trend: [
      { period: '0m', strongBuy: { raw: 10 }, buy: { raw: 12 }, hold: { raw: 6 }, sell: { raw: 2 }, strongSell: { raw: 0 } },
      { period: '-1m', strongBuy: { raw: 9 }, buy: { raw: 11 }, hold: { raw: 7 }, sell: { raw: 2 }, strongSell: { raw: 1 } },
    ],
  },
  earningsTrend: {
    trend: [
      { period: '0q', earningsEstimate: { growth: { raw: 0.05 } }, revenueEstimate: { growth: { raw: 0.03 } } },
      { period: '0y', earningsEstimate: { growth: { raw: 0.10 } }, revenueEstimate: { growth: { raw: 0.07 } } },
      { period: '+1y', earningsEstimate: { growth: { raw: 0.12 } }, revenueEstimate: { growth: { raw: 0.08 } } },
    ],
  },
};

class StubFetcher implements QuoteSummaryFetcher {
  constructor(private readonly result: Record<string, unknown> | null) {}
  async fetchModules(): Promise<Record<string, unknown> | null> { return this.result; }
}

describe('YahooAnalystEstimates extractor', () => {
  it('parses price target, recommendation, and forward growth (current/next year only)', async () => {
    const est = await new YahooAnalystEstimates(new StubFetcher(QS_RESULT)).fetch('AAPL_US_EQ');
    expect(est).not.toBeNull();
    expect(est!.priceTargetLow).toBe(150.0);
    expect(est!.priceTargetMean).toBe(200.5);
    expect(est!.priceTargetHigh).toBe(260.0);
    expect(est!.numberOfAnalysts).toBe(32);
    expect(est!.recommendationMean).toBe(1.9);
    expect(est!.recommendationKey).toBe('buy');
    // latest-period histogram only
    expect(est!.recommendation).toEqual({ strongBuy: 10, buy: 12, hold: 6, sell: 2, strongSell: 0 });
    // quarterly '0q' row dropped; only the annual forward rows survive
    expect(est!.earningsGrowth).toEqual([{ period: '0y', growth: 0.10 }, { period: '+1y', growth: 0.12 }]);
    expect(est!.revenueGrowth).toEqual([{ period: '0y', growth: 0.07 }, { period: '+1y', growth: 0.08 }]);
  });

  it('returns null on a 404 (no result) without throwing', async () => {
    const est = await new YahooAnalystEstimates(new StubFetcher(null)).fetch('AAPL_US_EQ');
    expect(est).toBeNull();
  });

  it('returns null (not a throw) when the fetcher errors', async () => {
    const thrower: QuoteSummaryFetcher = { fetchModules: async () => { throw new Error('session reset'); } };
    const est = await new YahooAnalystEstimates(thrower).fetch('AAPL_US_EQ');
    expect(est).toBeNull();
  });
});
