// Route-level tests for the operator force-emit hook (RC1 Task 3 — the epic capstone's QA trigger):
//   POST /admin/api/market-data/daily-emit/force  { market?, date? }
//
// Contracts pinned here:
//   - Admin-gated (401 without a token) — same parseAdminHeaders gate as the other market-data routes.
//   - Resolves the active-universe tickers per market by T212 suffix: US=_US_EQ, LSE=l_EQ. `market`
//     omitted ⇒ BOTH markets; a value narrows to that one (and its tickers only).
//   - Computes the UTC-day window: sinceTs = <date>T00:00:00Z (the OOM-safe lower floor), upperBoundTs
//     = sinceTs + 24h (so a PAST date folds only its single day). `date` omitted ⇒ today (UTC).
//   - Sums foldDailyEmit's per-market emitted counts; returns { emitted, market, date }.
//   - emitted:0 (never an error) when the fold finds no bars — the empty-day no-op.
//
// foldDailyEmit is mocked so the test is hermetic (no Mongo/Timescale/Redis) and focused on routing,
// ticker selection, and the window math — foldDailyEmit's own fold is covered in daily-emit-fold.test.ts.
process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { OHLCV_BARS: 'ohlcv_bars', INSTRUMENT_REGISTRY: 'instrument_registry', BAD_TICKS: 'bad_ticks' },
  getMongoDb: async () => ({ collection: () => ({ find: () => ({ project: () => ({ toArray: async () => [] }), toArray: async () => [] }), findOne: async () => null }) }),
}));
vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({ get: async () => null, setEx: async () => 'OK', del: async () => 0, publish: async () => 0 }),
  xAdd: async () => '',
  ensureConsumerGroup: async () => {},
}));

// Capture every foldDailyEmit call (which tickers, which window) and return a per-ticker emit count.
const foldCalls: Array<{ tickers: string[]; sinceTs: number; upperBoundTs?: number }> = [];
vi.mock('../modules/bars/infrastructure/daily-emit.ts', () => ({
  foldDailyEmit: async (
    _redis: unknown,
    _db: unknown,
    tickers: readonly string[],
    sinceTs: number,
    upperBoundTs?: number,
  ) => {
    foldCalls.push({ tickers: [...tickers], sinceTs, upperBoundTs });
    return { emitted: tickers.length };          // 1 emitted per ticker handed in
  },
}));

const { Hono } = await import('hono');
const { signAccessToken } = await import('@trader/shared-auth');
const { createAdminRouter } = await import('../modules/admin/routes.ts');
const { TwelveDataProvider } = await import('../modules/bars/infrastructure/providers/twelvedata-provider.ts');

// Mixed active universe: 2 US, 1 LSE — the suffix selection must split them.
const ACTIVE = ['AAPL_US_EQ', 'NVDA_US_EQ', 'VODl_EQ'];

function buildApp(activeTickers: string[] = ACTIVE) {
  const app = new Hono();
  const stubUM: any = { activeTickers, sectorMap: {}, refresh: async () => activeTickers };
  const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, fatal: () => {}, child: () => noopLog, level: 'info' } as never;
  const provider = new TwelveDataProvider({ apiKey: '', creditsPerMinute: 8, dailyCreditLimit: 800 });
  app.route('/', createAdminRouter(stubUM, provider, noopLog));
  return app;
}

const adminToken = async () => `Bearer ${await signAccessToken({ sub: 'admin-user', role: 'admin' })}`;
const post = async (app: ReturnType<typeof buildApp>, body: unknown) =>
  app.request('/admin/api/market-data/daily-emit/force', {
    method: 'POST',
    headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => { foldCalls.length = 0; });

describe('POST /admin/api/market-data/daily-emit/force', () => {
  it('requires an admin token (401 without)', async () => {
    const res = await buildApp().request('/admin/api/market-data/daily-emit/force', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
    expect(foldCalls).toHaveLength(0);
  });

  it('market="US", date set: folds ONLY the US tickers for that UTC day, returns the count', async () => {
    const res = await post(buildApp(), { market: 'US', date: '2026-06-12' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ emitted: 2, market: 'US', date: '2026-06-12' });     // 2 US names
    expect(foldCalls).toHaveLength(1);                                           // one market
    expect(foldCalls[0].tickers).toEqual(['AAPL_US_EQ', 'NVDA_US_EQ']);          // LSE excluded
    // The UTC-day window: floor at midnight, cap at next midnight.
    const since = Date.parse('2026-06-12T00:00:00.000Z');
    expect(foldCalls[0].sinceTs).toBe(since);
    expect(foldCalls[0].upperBoundTs).toBe(since + 24 * 60 * 60_000);
  });

  it('market omitted: emits BOTH markets, summing the per-market counts', async () => {
    const res = await post(buildApp(), { date: '2026-06-12' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emitted).toBe(3);             // 2 US + 1 LSE
    expect(body.market).toBe('ALL');
    expect(foldCalls).toHaveLength(2);         // one fold per market
    const tickerSets = foldCalls.map((c) => c.tickers.sort());
    expect(tickerSets).toContainEqual(['AAPL_US_EQ', 'NVDA_US_EQ']);
    expect(tickerSets).toContainEqual(['VODl_EQ']);
    // Both folds use the same window.
    const since = Date.parse('2026-06-12T00:00:00.000Z');
    for (const c of foldCalls) {
      expect(c.sinceTs).toBe(since);
      expect(c.upperBoundTs).toBe(since + 24 * 60 * 60_000);
    }
  });

  it('market="LSE": folds only the LSE tickers', async () => {
    const res = await post(buildApp(), { market: 'LSE', date: '2026-06-12' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ emitted: 1, market: 'LSE', date: '2026-06-12' });
    expect(foldCalls).toHaveLength(1);
    expect(foldCalls[0].tickers).toEqual(['VODl_EQ']);
  });

  it('date omitted: defaults to today (UTC), window floored at today\'s UTC midnight', async () => {
    const res = await post(buildApp(), { market: 'US' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const today = new Date().toISOString().slice(0, 10);
    expect(body.date).toBe(today);
    const since = Date.parse(`${today}T00:00:00.000Z`);
    expect(foldCalls[0].sinceTs).toBe(since);
    expect(foldCalls[0].upperBoundTs).toBe(since + 24 * 60 * 60_000);
  });

  it('emitted:0 (200, not an error) when a market has no active tickers', async () => {
    // LSE-only universe + market=US → no US names → no fold call, emitted 0, still 200.
    const res = await post(buildApp(['VODl_EQ']), { market: 'US', date: '2026-06-12' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emitted).toBe(0);
    expect(foldCalls).toHaveLength(0);
  });

  it('400 on a malformed date (not YYYY-MM-DD)', async () => {
    const res = await post(buildApp(), { date: '06/12/2026' });
    expect(res.status).toBe(400);
    expect(foldCalls).toHaveLength(0);
  });

  it('400 on an unknown market value', async () => {
    const res = await post(buildApp(), { market: 'TSE' });
    expect(res.status).toBe(400);
    expect(foldCalls).toHaveLength(0);
  });
});
