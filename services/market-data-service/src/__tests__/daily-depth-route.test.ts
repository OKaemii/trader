// Route-level tests for the capstone depth-check + the operator-gated deep-backfill driver:
//   GET  /admin/api/market-data/daily-depth   — per curated-US name {oldest, count}, OOM-safe
//   POST /admin/api/market-data/backfill-daily — extended with scope:'curated-us' + deep
//
// The load-bearing contracts pinned here:
//   - daily-depth is admin-gated (401 no token), returns {interval, tickers, depth:{ticker:{oldest,count}}}.
//   - It probes the curated-US subset of the active universe by default; ?tickers= overrides.
//   - CRITICAL (the whole reason the card exists): the depth read is OOM-safe — under
//     BARS_BACKEND=timescale it issues ONLY bounded queries (every SQL carries BOTH an
//     `observation_ts >= $` lower AND an `observation_ts < $` upper bound, so chunk-exclusion
//     prunes the plan). It NEVER runs an unbounded `min(observation_ts)/count(*)` aggregate — the
//     shape that locks every chunk → "out of shared memory" (the NVIDIA £0 OOM). A regression that
//     drops the time bounds fails this test before it can ship.
//   - backfill-daily: scope='curated-us' selects the curated-US subset; deep (or curated-us)
//     defaults years to DAILY_BACKFILL_YEARS; an explicit tickers list / years always wins.
//
// Mongo + Redis + shared-pg (getPgPool) are mocked. Hermetic, no network, no real Postgres.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mongo stub ──────────────────────────────────────────────────────────────────────────────────
// daily-depth on the (default) mongo backend reads via getDailyDepth → a single $group aggregate.
// Storage is keyed on the bare identity (symbol, market), so drive the aggregate off a per-identity
// daily series: AAPL has two bars (oldest 2006), ZZZZ none.
const obs2006 = Date.UTC(2006, 0, 3);
const obsRecent = Date.UTC(2026, 4, 14);
const dailyByIdentity: Record<string, Array<{ observation_ts: number }>> = {
  'AAPL|US': [{ observation_ts: obs2006 }, { observation_ts: obsRecent }],
  'NVDA|US': [{ observation_ts: Date.UTC(2010, 0, 4) }],
  'ZZZZ|US': [],
};

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { OHLCV_BARS: 'ohlcv_bars', INSTRUMENT_REGISTRY: 'instrument_registry', BAD_TICKS: 'bad_ticks' },
  getMongoDb: async () => ({
    collection: () => ({
      // Only the $group depth aggregate is exercised here. Compute {oldest, count} from the
      // matched (symbol, market) series so the route returns a real shape.
      aggregate: (pipeline: Array<Record<string, unknown>>) => ({
        toArray: async () => {
          const match = (pipeline[0] as { $match?: { symbol?: string; market?: string } })?.$match ?? {};
          const rows = dailyByIdentity[`${match.symbol ?? ''}|${match.market ?? ''}`] ?? [];
          if (rows.length === 0) return [];
          const oldest = Math.min(...rows.map((r) => r.observation_ts));
          return [{ _id: null, oldest, count: rows.length }];
        },
      }),
      find:    () => ({ project: () => ({ toArray: async () => [] }), toArray: async () => [] }),
      findOne: async () => null,
    }),
    listCollections: () => ({ toArray: async () => [] }),
  }),
}));

vi.mock('@trader/shared-redis', () => ({
  getRedisClient: async () => ({
    get: async () => null,
    setEx: async () => 'OK',
    del: async () => 0,
    publish: async () => 0,
  }),
  xAdd: async () => '',
  ensureConsumerGroup: async () => {},
}));

// ── shared-pg stub — capture every SQL the timescale depth read runs ──────────────────────────────
// getDailyDepthPg calls getPgPool().query(sql, params). We record the SQL so the OOM-safety test can
// assert every query is bounded on BOTH sides of observation_ts (never an unbounded aggregate).
const pgQueries: Array<{ sql: string; params: unknown[] }> = [];
vi.mock('@trader/shared-pg', () => ({
  getPgPool: () => ({
    query: async (sql: string, params: unknown[]) => {
      pgQueries.push({ sql, params });
      // Return rows so the walk accumulates: pretend a single bar lives in the 2006 window for
      // (symbol 'AAPL', market 'US'), everything else empty. params = [symbol, market, interval, lo, hi].
      const [symbol, market, , lo, hi] = params as [string, string, string, number, number];
      const inWindow = symbol === 'AAPL' && market === 'US' && obs2006 >= (lo as number) && obs2006 < (hi as number);
      return { rows: inWindow ? [{ n: '1', oldest: String(obs2006) }] : [{ n: '0', oldest: null }] };
    },
  }),
}));

// ── deep-backfill stub — capture the tickers + opts the driver passes ─────────────────────────────
const backfillCalls: Array<{ tickers: string[]; opts: { years?: number; forceRefetch?: boolean } }> = [];
vi.mock('../modules/bars/infrastructure/daily-history.ts', () => ({
  backfillDailyHistory: async (
    _db: unknown,
    _redis: unknown,
    tickers: string[],
    opts: { years?: number; forceRefetch?: boolean },
  ) => {
    backfillCalls.push({ tickers, opts });
    return tickers.map((t) => ({ ticker: t, fetched: 1, upserted: 1 }));
  },
}));

const { Hono } = await import('hono');
const { signAccessToken } = await import('@trader/shared-auth');
const { createAdminRouter, curatedUsTickers } = await import('../modules/admin/routes.ts');
const { TwelveDataProvider } = await import('../modules/bars/infrastructure/providers/twelvedata-provider.ts');

// A mixed active universe: 2 curated-US names + 1 LSE name. curatedUsTickers must keep only the US.
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

beforeEach(() => {
  pgQueries.length = 0;
  backfillCalls.length = 0;
});
afterEach(() => {
  delete process.env.BARS_BACKEND;
  delete process.env.DAILY_BACKFILL_YEARS;
});

describe('curatedUsTickers (selection helper)', () => {
  it('keeps only _US_EQ names, drops LSE/other suffixes', () => {
    expect(curatedUsTickers(ACTIVE)).toEqual(['AAPL_US_EQ', 'NVDA_US_EQ']);
    expect(curatedUsTickers([])).toEqual([]);
    expect(curatedUsTickers(['VODl_EQ', 'BPl_EQ'])).toEqual([]);
  });
});

describe('GET /admin/api/market-data/daily-depth', () => {
  it('requires an admin token (401 without)', async () => {
    const res = await buildApp().request('/admin/api/market-data/daily-depth');
    expect(res.status).toBe(401);
  });

  it('probes the curated-US subset of the active universe and returns {oldest, count} per name', async () => {
    const res = await buildApp().request('/admin/api/market-data/daily-depth', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.interval).toBe('daily');
    // Only the 2 curated-US names — the LSE name (VODl_EQ) is excluded.
    expect(body.tickers).toBe(2);
    expect(Object.keys(body.depth).sort()).toEqual(['AAPL_US_EQ', 'NVDA_US_EQ']);
    // AAPL reaches 2006 (the depth claim); count is the unsuperseded row total.
    expect(body.depth.AAPL_US_EQ.oldest).toBe(obs2006);
    expect(body.depth.AAPL_US_EQ.count).toBe(2);
    expect(body.depth.NVDA_US_EQ.oldest).toBe(Date.UTC(2010, 0, 4));
    expect(body.depth.NVDA_US_EQ.count).toBe(1);
  });

  it('honours an explicit ?tickers= list (incl. a name with no bars → oldest null, count 0)', async () => {
    const res = await buildApp().request('/admin/api/market-data/daily-depth?tickers=AAPL_US_EQ,ZZZZ_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tickers).toBe(2);
    expect(body.depth.AAPL_US_EQ.oldest).toBe(obs2006);
    expect(body.depth.ZZZZ_US_EQ).toEqual({ oldest: null, count: 0 });
  });

  it('400 when no curated-US names and no ?tickers=', async () => {
    const res = await buildApp(['VODl_EQ']).request('/admin/api/market-data/daily-depth', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(400);
  });

  it('400 on an invalid interval', async () => {
    const res = await buildApp().request('/admin/api/market-data/daily-depth?interval=bogus', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(400);
  });
});

// The regression guard the whole card exists for: the depth read must NOT reintroduce the
// unbounded-aggregate / range='max' scan that exhausted Timescale's lock table (NVIDIA £0). Under the
// timescale backend, EVERY query getDailyDepth runs must be bounded on BOTH sides of observation_ts.
describe('GET /admin/api/market-data/daily-depth — OOM-safety (timescale backend, no unbounded scan)', () => {
  it('issues ONLY bounded queries — every SQL carries observation_ts >= $ AND observation_ts < $', async () => {
    process.env.BARS_BACKEND = 'timescale';
    const res = await buildApp().request('/admin/api/market-data/daily-depth?tickers=AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The bounded walk still surfaces the 2006 oldest (the window containing it returns a row).
    expect(body.depth.AAPL_US_EQ.oldest).toBe(obs2006);

    // It actually went to PG (not a cache/short-circuit), and ran several windowed queries.
    expect(pgQueries.length).toBeGreaterThan(1);
    for (const { sql, params } of pgQueries) {
      const normalised = sql.replace(/\s+/g, ' ');
      // BOTH bounds present — this is what prunes chunk-exclusion. A missing lower bound is the OOM.
      expect(normalised).toMatch(/observation_ts\s*>=\s*\$/);
      expect(normalised).toMatch(/observation_ts\s*<\s*\$/);
      // The is_superseded fast-lane filter (live series), and the time bounds are real ms params.
      expect(normalised).toMatch(/is_superseded\s*=\s*FALSE/);
      // params = [symbol, market, interval, lo, hi] now (symbol+market lead the bounded query).
      const [, , , lo, hi] = params as [string, string, string, number, number];
      expect(typeof lo).toBe('number');
      expect(typeof hi).toBe('number');
      expect(lo).toBeLessThan(hi);
    }
    // No query is an unbounded full-series aggregate (the exact shape that OOM'd): there must be NO
    // SQL that selects min/count WITHOUT both observation_ts bounds.
    const unbounded = pgQueries.filter(({ sql }) => {
      const n = sql.replace(/\s+/g, ' ');
      const isAgg = /count\(\*\)/i.test(n) || /min\(observation_ts\)/i.test(n);
      const lowerBounded = /observation_ts\s*>=\s*\$/.test(n);
      const upperBounded = /observation_ts\s*<\s*\$/.test(n);
      return isAgg && (!lowerBounded || !upperBounded);
    });
    expect(unbounded).toHaveLength(0);
  });
});

describe('POST /admin/api/market-data/backfill-daily — deep-backfill driver (operator-gated)', () => {
  it('scope=curated-us seeds the curated-US subset with years defaulting to DAILY_BACKFILL_YEARS', async () => {
    process.env.DAILY_BACKFILL_YEARS = '35';
    const res = await buildApp().request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'curated-us', deep: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('curated-us');
    expect(body.deep).toBe(true);
    expect(body.years).toBe(35);
    // Drove the existing gap-aware backfill across the curated-US subset only (LSE excluded), deep.
    expect(backfillCalls).toHaveLength(1);
    expect(backfillCalls[0].tickers).toEqual(['AAPL_US_EQ', 'NVDA_US_EQ']);
    expect(backfillCalls[0].opts.years).toBe(35);
    expect(backfillCalls[0].opts.forceRefetch).toBe(false); // gap-aware, NOT a force re-download
  });

  it('scope=curated-us alone (no deep flag) still implies the deep default years', async () => {
    process.env.DAILY_BACKFILL_YEARS = '35';
    const res = await buildApp().request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'curated-us' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deep).toBe(true);
    expect(backfillCalls[0].opts.years).toBe(35);
  });

  it('an explicit years wins over the deep default', async () => {
    process.env.DAILY_BACKFILL_YEARS = '35';
    const res = await buildApp().request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'curated-us', years: 20 }),
    });
    expect(res.status).toBe(200);
    expect(backfillCalls[0].opts.years).toBe(20);
  });

  it('an explicit tickers list wins over scope', async () => {
    const res = await buildApp().request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'curated-us', tickers: ['MSFT_US_EQ'] }),
    });
    expect(res.status).toBe(200);
    expect(backfillCalls[0].tickers).toEqual(['MSFT_US_EQ']);
  });

  it('default (no scope) backfills the whole active universe, no deep default', async () => {
    const res = await buildApp().request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe('active');
    expect(body.deep).toBe(false);
    expect(backfillCalls[0].tickers).toEqual(ACTIVE); // whole universe, incl. LSE
    expect(backfillCalls[0].opts.years).toBeUndefined(); // falls through to backfillDailyHistory default
  });

  it('400 when scope=curated-us yields no US names', async () => {
    const res = await buildApp(['VODl_EQ']).request('/admin/api/market-data/backfill-daily', {
      method: 'POST',
      headers: { Authorization: await adminToken(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'curated-us' }),
    });
    expect(res.status).toBe(400);
    expect(backfillCalls).toHaveLength(0);
  });
});
