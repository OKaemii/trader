// Scanner reflects the PIT source honestly (pit-coverage-broaden Task 8). Two surfaces:
//   GET /admin/api/market-data/scanner/snapshot     → each row carries a per-name `source`
//     (`pit-edgar` US-warehouse hit / `yahoo` PIT-fall-back-or-yahoo-mode / `eodhd`; null = unfetched).
//   GET /admin/api/market-data/scanner/feed-health  → config.fundamentalsProvider is the EFFECTIVE
//     provider the wired cache runs (FundamentalsCache.effectiveSource), `yahoo` today.
// Plus the load-bearing FundamentalsCache.refresh extension that PERSISTS the per-name source the
// provider reports (via the optional FundamentalsProvider.sourceOf), which `peek` then serves to the
// snapshot — the portal source badge (#150) consumes this. `process.env.FUNDAMENTALS_PROVIDER` does
// NOT influence the snapshot source any more: it is read from the cached row, not re-parsed here.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi } from 'vitest';

// instrument_registry rows for the snapshot's name/market join. Keyed on the bare (symbol, market)
// identity since Task 16b — the route queries find({ $or:[{symbol,market}], activeTo: null }) and
// re-keys the result back to the T212 ticker; the stub returns the rows regardless of query.
const REGISTRY: Array<{ symbol: string; market: string; name: string; activeTo: null }> = [
  { symbol: 'AAPL', market: 'US',  name: 'Apple Inc.', activeTo: null },
  { symbol: 'SHEL', market: 'LSE', name: 'Shell plc',  activeTo: null },
  { symbol: 'TSLA', market: 'US',  name: 'Tesla Inc.', activeTo: null },
];
vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { INSTRUMENT_REGISTRY: 'instrument_registry', COMPANY_FUNDAMENTALS: 'company_fundamentals' },
  getMongoDb: async () => ({
    collection: (_name: string) => ({
      find: (_q: unknown) => ({ toArray: async () => REGISTRY }),
    }),
  }),
}));

// feed-health peeks Redis for the per-market daily-feed flags; only `get` is touched.
vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({ get: async () => null }),
}));

const { Hono } = await import('hono');
const { signAccessToken } = await import('@trader/shared-auth');
const { createScannerRouter } = await import('../modules/scanner/routes.ts');
const { FundamentalsCache } = await import('../modules/fundamentals/application/FundamentalsCache.ts');
import type { FundamentalsCache as FundamentalsCacheType, FundamentalsDoc } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { FundamentalsProvider, FundamentalsRaw } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';
import type { UniverseManager } from '../modules/universe/application/UniverseManager.ts';

const adminToken = async () => `Bearer ${await signAccessToken({ sub: 'admin-user', role: 'admin' })}`;

const RAW = (mc: number): FundamentalsRaw => ({
  netIncome: 100, totalEquity: 500, totalDebt: 200, currentAssets: 300, currentLiabilities: 150, marketCapGbp: mc,
});
const doc = (id: string, source: string, mc: number, symbol = 'X', market = 'US'): FundamentalsDoc => ({
  _id: id, symbol, market, asOf: 1_700_000_000_000, raw: RAW(mc), ratios: { roe: 0.2, debtToEquity: 0.4, currentRatio: 2.0 },
  qualityPass: true, marketCapGbp: mc, source, updatedAt: 1_700_000_000_000,
});

// A scanner router over a stubbed cache (`peek` for snapshot, `coverage` + `effectiveSource` for
// feed-health) and a universe with two US + one LSE name. The third US name (TSLA) has NO cached
// fundamentals doc — it must surface `source: null`, never a fabricated provenance.
function buildApp(opts: { peekDocs?: Record<string, FundamentalsDoc>; effectiveSource?: string } = {}) {
  const peekDocs = opts.peekDocs ?? {
    AAPL_US_EQ: doc('AAPL_US_EQ', 'pit-edgar', 3_000_000),  // US warehouse hit
    SHELl_EQ:   doc('SHELl_EQ',   'yahoo',     2_000_000),  // non-US → Yahoo fall-back
  };
  const universe = {
    activeTickers: ['AAPL_US_EQ', 'SHELl_EQ', 'TSLA_US_EQ'],
    sectorMap: { AAPL_US_EQ: 'Technology', SHELl_EQ: 'Energy', TSLA_US_EQ: 'Consumer' },
    refresh: async () => ['AAPL_US_EQ'],
  } as unknown as UniverseManager;
  const fundamentals = {
    peek: async (tickers: string[]) => Object.fromEntries(tickers.filter((t) => peekDocs[t]).map((t) => [t, peekDocs[t]])),
    coverage: async () => ({ count: Object.keys(peekDocs).length, passing: 2, oldestAsOf: 1_700_000_000_000 }),
    effectiveSource: opts.effectiveSource ?? 'yahoo',
  } as unknown as FundamentalsCacheType;
  const app = new Hono();
  app.route('/', createScannerRouter(universe, fundamentals));
  return app;
}

describe('GET /admin/api/market-data/scanner/snapshot — per-name source', () => {
  it('401s without an admin token', async () => {
    const res = await buildApp().request('/admin/api/market-data/scanner/snapshot');
    expect(res.status).toBe(401);
  });

  it('carries each row’s per-name source from the cached doc (pit-edgar / yahoo)', async () => {
    const res = await buildApp().request('/admin/api/market-data/scanner/snapshot', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const byTicker = Object.fromEntries(body.rows.map((r: { ticker: string }) => [r.ticker, r]));
    expect(byTicker.AAPL_US_EQ.source).toBe('pit-edgar');   // US warehouse hit
    expect(byTicker.SHELl_EQ.source).toBe('yahoo');         // non-US fall-back
  });

  it('surfaces source: null for a name with no cached fundamentals (never a fabricated source)', async () => {
    const res = await buildApp().request('/admin/api/market-data/scanner/snapshot', {
      headers: { Authorization: await adminToken() },
    });
    const body = await res.json();
    const tsla = body.rows.find((r: { ticker: string }) => r.ticker === 'TSLA_US_EQ');
    expect(tsla).toBeDefined();
    expect(tsla.source).toBeNull();
    expect(tsla.qualityPass).toBeNull();   // unchanged: unfetched stays null, not a fabricated 0
  });

  it('keeps the existing row + summary shape (source is additive)', async () => {
    const res = await buildApp().request('/admin/api/market-data/scanner/snapshot', {
      headers: { Authorization: await adminToken() },
    });
    const body = await res.json();
    expect(body.universeSize).toBe(3);
    expect(body.qualityKnown).toBe(2);       // AAPL + SHEL fetched
    expect(body.qualityPassCount).toBe(2);
    const aapl = body.rows.find((r: { ticker: string }) => r.ticker === 'AAPL_US_EQ');
    expect(aapl.name).toBe('Apple Inc.');
    expect(aapl.market).toBe('US');
    expect(aapl.sector).toBe('Technology');
    expect(aapl.ratios).toEqual({ roe: 0.2, debtToEquity: 0.4, currentRatio: 2.0 });
  });
});

describe('GET /admin/api/market-data/scanner/feed-health — effective provider', () => {
  it('reports the effective fundamentalsProvider from the wired cache (yahoo today)', async () => {
    const res = await buildApp().request('/admin/api/market-data/scanner/feed-health', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.fundamentalsProvider).toBe('yahoo');
  });

  it('reflects the pit mode once the cache runs pit (the capstone flip), not a process.env re-read', async () => {
    // Prove it tracks the cache, not the env var: set the env to yahoo while the cache runs pit.
    const prev = process.env.FUNDAMENTALS_PROVIDER;
    process.env.FUNDAMENTALS_PROVIDER = 'yahoo';
    try {
      const res = await buildApp({ effectiveSource: 'pit' }).request('/admin/api/market-data/scanner/feed-health', {
        headers: { Authorization: await adminToken() },
      });
      const body = await res.json();
      expect(body.config.fundamentalsProvider).toBe('pit');
    } finally {
      if (prev === undefined) delete process.env.FUNDAMENTALS_PROVIDER;
      else process.env.FUNDAMENTALS_PROVIDER = prev;
    }
  });
});

// FundamentalsCache.refresh persists the per-name source the provider reports, so the later `peek`
// (snapshot) carries `pit-edgar`/`yahoo` per ticker rather than one blanket mode string. A provider
// without `sourceOf` (Yahoo/EODHD) stamps the configured mode — byte-for-byte the prior behaviour.
describe('FundamentalsCache.refresh — per-name source stamping', () => {
  // In-memory company_fundamentals collection capturing the $set each upsert writes.
  function stubColl() {
    const writes: Array<{ id: string; set: Record<string, unknown> }> = [];
    const coll = {
      find: (_q: unknown, _opts?: unknown) => ({ toArray: async () => [] }),
      updateOne: async (q: { _id: string }, update: { $set: Record<string, unknown> }) => {
        writes.push({ id: q._id, set: update.$set });
        return { acknowledged: true };
      },
    };
    return { coll, writes };
  }

  it('stamps the provider’s per-name source when it exposes sourceOf (pit: pit-edgar vs yahoo)', async () => {
    const { coll, writes } = stubColl();
    const provider: FundamentalsProvider = {
      fetch: async () => ({ AAPL_US_EQ: RAW(3_000_000), SHELl_EQ: RAW(2_000_000) }),
      sourceOf: (t) => (t === 'AAPL_US_EQ' ? 'pit-edgar' : 'yahoo'),
    };
    const cache = new FundamentalsCache(provider, 'pit');
    // Inject the stub collection (private `coll()` is the single DB seam).
    (cache as unknown as { coll: () => Promise<typeof coll> }).coll = async () => coll;

    const written = await cache.refresh(['AAPL_US_EQ', 'SHELl_EQ']);
    expect(written).toBe(2);
    // company_fundamentals is keyed on the '<symbol>:<market>' composite _id since Task 16b, with
    // symbol+market also written as fields. Assert the per-name source against the new key.
    const byId = Object.fromEntries(writes.map((w) => [w.id, w.set]));
    expect(byId['AAPL:US'].source).toBe('pit-edgar');
    expect(byId['AAPL:US'].symbol).toBe('AAPL');
    expect(byId['AAPL:US'].market).toBe('US');
    expect(byId['SHEL:LSE'].source).toBe('yahoo');
    expect(byId['SHEL:LSE'].symbol).toBe('SHEL');
  });

  it('stamps the configured mode when the provider has no sourceOf (yahoo/eodhd unchanged)', async () => {
    const { coll, writes } = stubColl();
    const provider: FundamentalsProvider = { fetch: async () => ({ AAPL_US_EQ: RAW(3_000_000) }) };
    const cache = new FundamentalsCache(provider, 'yahoo');
    (cache as unknown as { coll: () => Promise<typeof coll> }).coll = async () => coll;

    await cache.refresh(['AAPL_US_EQ']);
    expect(writes[0].set.source).toBe('yahoo');
  });

  it('exposes the configured mode as effectiveSource', () => {
    expect(new FundamentalsCache({ fetch: async () => ({}) }, 'pit').effectiveSource).toBe('pit');
    expect(new FundamentalsCache({ fetch: async () => ({}) }, 'yahoo').effectiveSource).toBe('yahoo');
  });
});
