// Pipeline C route + store-integration tests (plan ## Task 12). Drives the real ConsensusStore +
// createConsensusRouter against an in-memory Mongo mock (no network, no real Mongo). The contracts
// pinned here:
//   - The routes are admin-gated (401 without a token).
//   - With the SHIPPED StubConsensusProvider the stores stay empty → the routes return the honest empty
//     shape: { consensus: [] } / { surprises: [] } / { estimates: 0, surprises: 0 }, each carrying
//     `requiresConsensus: true` (the "requires consensus — not sourced" marker), never a fabricated row.
//   - refresh() with the stub writes NOTHING (no consensus → no surprise; "not built rather than faked").
//   - refresh() with a SYNTHETIC consensus provider (the future EODHD/vendor swap) DOES derive a
//     surprise — and only where a consensus EPS estimate AND a realised actual coexist — proving the
//     surprise_pct path is wired correctly via the pure surprisePct(). This is the swap-readiness test.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory Mongo mock ──────────────────────────────────────────────────────────────────────────
// One Map per collection name keyed by `_id`. Supports the store's find().sort().toArray(),
// countDocuments(), and updateOne({_id}, {$set}, {upsert:true}). Reset per test via __resetMongo().
type Doc = Record<string, unknown> & { _id: string };
const stores = new Map<string, Map<string, Doc>>();
function coll(name: string): Map<string, Doc> {
  let m = stores.get(name);
  if (!m) { m = new Map(); stores.set(name, m); }
  return m;
}

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { CONSENSUS_ESTIMATE: 'consensus_estimate', EARNINGS_SURPRISE: 'earnings_surprise' },
  getMongoDb: async () => ({
    collection: (name: string) => ({
      find: (q: { symbol?: string; market?: string }) => {
        let rows = [...coll(name).values()];
        if (q?.symbol !== undefined) rows = rows.filter((d) => d.symbol === q.symbol);
        if (q?.market !== undefined) rows = rows.filter((d) => d.market === q.market);
        return {
          sort: (spec: Record<string, 1 | -1>) => {
            const [[key, dir]] = Object.entries(spec);
            rows.sort((a, b) => {
              const av = a[key] as number | string, bv = b[key] as number | string;
              return (av < bv ? -1 : av > bv ? 1 : 0) * (dir as number);
            });
            return { toArray: async () => rows };
          },
          toArray: async () => rows,
        };
      },
      countDocuments: async () => coll(name).size,
      updateOne: async (
        filter: { _id: string },
        update: { $set: Record<string, unknown> },
        _opts: { upsert?: boolean },
      ) => {
        coll(name).set(filter._id, { _id: filter._id, ...update.$set });
        return { acknowledged: true };
      },
    }),
  }),
}));

const { Hono } = await import('hono');
const { signAccessToken } = await import('@trader/shared-auth');
const { ConsensusStore } = await import('../modules/consensus/application/ConsensusStore.ts');
const { StubConsensusProvider } = await import('../modules/consensus/infrastructure/StubConsensusProvider.ts');
const { createConsensusRouter } = await import('../modules/consensus/routes.ts');
import type { ConsensusProvider, ConsensusData } from '../modules/consensus/infrastructure/ConsensusProvider.ts';

const adminToken = async () => `Bearer ${await signAccessToken({ sub: 'admin-user', role: 'admin' })}`;

function buildApp(store: InstanceType<typeof ConsensusStore>) {
  const app = new Hono();
  app.route('/', createConsensusRouter(store));
  return app;
}

beforeEach(() => stores.clear());

describe('createConsensusRouter — admin gating', () => {
  const stub = () => new ConsensusStore(new StubConsensusProvider(), 'stub');

  it('401 without an admin token on consensus, earnings-surprise, and coverage', async () => {
    const app = buildApp(stub());
    expect((await app.request('/admin/api/market-data/consensus/AAPL_US_EQ')).status).toBe(401);
    expect((await app.request('/admin/api/market-data/earnings-surprise/AAPL_US_EQ')).status).toBe(401);
    expect((await app.request('/admin/api/market-data/consensus-coverage')).status).toBe(401);
  });
});

describe('createConsensusRouter — honest empty shape (Pipeline C stubbed)', () => {
  const stub = () => new ConsensusStore(new StubConsensusProvider(), 'stub');

  it('consensus returns an empty list with the requires-consensus marker', async () => {
    const res = await buildApp(stub()).request('/admin/api/market-data/consensus/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: 'AAPL_US_EQ', requiresConsensus: true, consensus: [] });
  });

  it('earnings-surprise returns an empty list with the requires-consensus marker (no fabricated surprise)', async () => {
    const res = await buildApp(stub()).request('/admin/api/market-data/earnings-surprise/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ticker: 'AAPL_US_EQ', requiresConsensus: true, surprises: [] });
  });

  it('coverage reports zero estimates and zero surprises while stubbed', async () => {
    const res = await buildApp(stub()).request('/admin/api/market-data/consensus-coverage', {
      headers: { Authorization: await adminToken() },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ estimates: 0, surprises: 0, requiresConsensus: true });
  });
});

describe('ConsensusStore.refresh — stub writes nothing (the shipped state)', () => {
  it('persists no estimate and no surprise row, so coverage stays {0, 0}', async () => {
    const store = new ConsensusStore(new StubConsensusProvider(), 'stub');
    const counts = await store.refresh(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(counts).toEqual({ estimates: 0, surprises: 0 });
    expect(await store.coverage()).toEqual({ estimates: 0, surprises: 0 });
    expect(stores.get('consensus_estimate') ?? new Map()).toEqual(new Map());
    expect(stores.get('earnings_surprise') ?? new Map()).toEqual(new Map());
  });
});

// The swap-readiness test: a SYNTHETIC provider standing in for a future EODHD/gold-standard vendor.
// It proves the store derives a real surprise from a consensus EPS estimate + a realised actual — and
// ONLY where both coexist — exercising the surprise_pct path end-to-end through the route.
class FakeVendorProvider implements ConsensusProvider {
  async fetch(tickers: string[]): Promise<Record<string, ConsensusData>> {
    const out: Record<string, ConsensusData> = {};
    if (tickers.includes('AAPL_US_EQ')) {
      out['AAPL_US_EQ'] = {
        estimates: [
          { fiscalPeriod: 'FY2025', metric: 'eps', consensus: 6.0, numAnalysts: 30, snapshotDate: 1_700_000_000_000 },
          // A forward period with an estimate but NO realised actual yet → no surprise row for it.
          { fiscalPeriod: 'FY2026', metric: 'eps', consensus: 6.5, numAnalysts: 28, snapshotDate: 1_700_000_000_000 },
        ],
        actuals: [
          { fiscalPeriod: 'FY2025', actualEps: 6.6 },          // beat: (6.6−6.0)/6.0 = +0.10
          // An actual with NO matching consensus estimate → must NOT produce a (faked) surprise.
          { fiscalPeriod: 'FY2024', actualEps: 5.0 },
        ],
      };
    }
    return out; // names without coverage are omitted (never an empty {estimates:[],actuals:[]})
  }
}

describe('ConsensusStore.refresh — synthetic vendor (swap-readiness)', () => {
  beforeEach(() => stores.clear());

  it('derives a surprise only where consensus + actual coexist, via the surprise_pct math', async () => {
    const store = new ConsensusStore(new FakeVendorProvider(), 'fake-vendor');
    const counts = await store.refresh(['AAPL_US_EQ', 'MSFT_US_EQ']);
    // Two estimates written (FY2025, FY2026); one surprise (FY2025 only — FY2026 has no actual, FY2024
    // has no consensus). MSFT is omitted by the provider, so nothing for it.
    expect(counts).toEqual({ estimates: 2, surprises: 1 });

    const surprises = await store.surprisesFor('AAPL_US_EQ');
    expect(surprises).toHaveLength(1);
    expect(surprises[0].fiscalPeriod).toBe('FY2025');
    expect(surprises[0].actualEps).toBe(6.6);
    expect(surprises[0].consensusEps).toBe(6.0);
    expect(surprises[0].surprisePct).toBeCloseTo(0.1, 10); // the +10% beat
    expect(surprises[0].ticker).toBe('AAPL_US_EQ');        // T212 ticker re-derived from (symbol, market)

    // The route now serves that real surprise (still honest — requiresConsensus stays true).
    const res = await buildApp(store).request('/admin/api/market-data/earnings-surprise/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    const body = await res.json();
    expect(body.surprises).toHaveLength(1);
    expect(body.surprises[0].surprisePct).toBeCloseTo(0.1, 10);

    // And the estimates route serves both forward estimates.
    const estRes = await buildApp(store).request('/admin/api/market-data/consensus/AAPL_US_EQ', {
      headers: { Authorization: await adminToken() },
    });
    const estBody = await estRes.json();
    expect(estBody.consensus).toHaveLength(2);
    expect(estBody.consensus.map((e: { fiscalPeriod: string }) => e.fiscalPeriod).sort())
      .toEqual(['FY2025', 'FY2026']);
  });
});
