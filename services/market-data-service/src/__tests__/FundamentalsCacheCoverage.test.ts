// FundamentalsCache.coverage() honesty split (RC2 surface, Task 8). After Task 7, a `terminal` name
// (non-US fail-closed / no-EDGAR US miss) is a real Mongo row written as a TOMBSTONE
// (unavailable:true, qualityPass:false). The old coverage() lumped those into `count` against a
// passing minority, so the feed-health panel read as "broken coverage" (e.g. 60 count / 19 passing,
// with 32 of the 60 being by-design tombstones). coverage() now returns
// { count, covered, unavailable, passing, oldestAsOf }: `unavailable` = tombstones, `covered` = real
// rows (count − unavailable), `passing` = covered rows that pass QMJ (tombstones excluded). The
// invariant the surfaces + QA rely on is `covered + unavailable === count`.
//
// The unit is coverage() reading the collection, so a tiny in-memory company_fundamentals
// (id→doc Map supporting find({}) / find({_id:{$in}})) models persistence — coverage() does an
// unfiltered find({}), which the helper returns whole.

import { describe, it, expect } from 'vitest';
import { FundamentalsCache } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { FundamentalsProvider } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';
import type { FundamentalsDoc } from '../modules/fundamentals/application/FundamentalsCache.ts';

// coverage() never calls the provider — a no-op satisfies the constructor.
const noopProvider: FundamentalsProvider = { fetch: async () => ({ values: {}, status: {} }) };

// In-memory company_fundamentals keyed on '<symbol>:<market>'. coverage() calls
// find({}, { projection }).toArray(); the unfiltered query returns every doc (projection ignored —
// the real fields are present on the seeded docs, so the filter reads them directly).
function inMemoryColl(seed: FundamentalsDoc[]) {
  const docs = new Map<string, FundamentalsDoc>(seed.map((d) => [d._id, d]));
  const coll = {
    find: (q: { _id?: { $in?: string[] } }, _opts?: unknown) => ({
      toArray: async () => {
        const ids = q._id?.$in;
        const all = [...docs.values()];
        return ids ? all.filter((d) => ids.includes(d._id)) : all;
      },
    }),
  };
  return { coll, docs };
}

// Bind the in-memory collection into the cache's single DB seam (private `coll()`).
function withColl(cache: FundamentalsCache, coll: ReturnType<typeof inMemoryColl>['coll']): FundamentalsCache {
  (cache as unknown as { coll: () => Promise<typeof coll> }).coll = async () => coll;
  return cache;
}

// A real (non-tombstone) row. `pass` drives qualityPass; `unavailable` is explicitly false (Task 7
// stamps real rows with unavailable:false).
function realRow(id: string, pass: boolean, asOf: number): FundamentalsDoc {
  const [symbol, market] = id.split(':');
  return {
    _id: id, symbol, market, asOf,
    raw: { netIncome: 100, totalEquity: 500, totalDebt: 200, currentAssets: 300, currentLiabilities: 150, marketCapGbp: 1_000 },
    ratios: null, qualityPass: pass, marketCapGbp: 1_000, source: 'pit-edgar', unavailable: false, updatedAt: asOf,
  };
}

// A tombstone row (the Task 7 terminal-name shape): every payload field null, unavailable:true,
// qualityPass:false.
function tombstone(id: string, asOf: number): FundamentalsDoc {
  const [symbol, market] = id.split(':');
  return {
    _id: id, symbol, market, asOf,
    raw: null, ratios: null, qualityPass: false, marketCapGbp: null, source: null, unavailable: true, updatedAt: asOf,
  };
}

describe('FundamentalsCache.coverage — covered/unavailable honesty split', () => {
  it('splits a mix of real rows + tombstones into covered/unavailable/passing (covered + unavailable === count)', async () => {
    // 3 real rows (2 passing, 1 failing) + 2 tombstones = 5 docs.
    const { coll } = inMemoryColl([
      realRow('AAPL:US', true, 1_000),
      realRow('MSFT:US', true, 2_000),
      realRow('XYZ:US', false, 3_000),   // covered but fails QMJ
      tombstone('VOD:LSE', 4_000),       // non-US fail-closed
      tombstone('TCEHY:US', 5_000),      // US no-EDGAR miss
    ]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov.count).toBe(5);
    expect(cov.unavailable).toBe(2);     // the two tombstones
    expect(cov.covered).toBe(3);         // the three real rows
    expect(cov.passing).toBe(2);         // only real rows that pass QMJ (the failing real row excluded)
    expect(cov.covered + cov.unavailable).toBe(cov.count); // the invariant the QA reconciles
    expect(cov.oldestAsOf).toBe(1_000);  // min asOf across ALL docs (real + tombstone)
  });

  it('counts a tombstone as unavailable, never as covered or passing, even if a stray qualityPass:true slipped onto it', async () => {
    // Defensive: the `passing`/`covered` split keys off `unavailable`, not just `qualityPass`. A
    // tombstone must never count as covered/passing regardless of its qualityPass field.
    const tombWithStrayPass: FundamentalsDoc = { ...tombstone('TCEHY:US', 9_000), qualityPass: true };
    const { coll } = inMemoryColl([realRow('AAPL:US', true, 1_000), tombWithStrayPass]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov.count).toBe(2);
    expect(cov.unavailable).toBe(1);
    expect(cov.covered).toBe(1);
    expect(cov.passing).toBe(1);         // the tombstone's stray qualityPass:true is NOT counted
    expect(cov.covered + cov.unavailable).toBe(cov.count);
  });

  it('all real rows → unavailable:0 and covered === count', async () => {
    const { coll } = inMemoryColl([
      realRow('AAPL:US', true, 1_000),
      realRow('MSFT:US', false, 2_000),
    ]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov).toEqual({ count: 2, covered: 2, unavailable: 0, passing: 1, oldestAsOf: 1_000 });
  });

  it('all tombstones → covered:0, passing:0, unavailable === count', async () => {
    const { coll } = inMemoryColl([tombstone('VOD:LSE', 4_000), tombstone('TCEHY:US', 5_000)]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov).toEqual({ count: 2, covered: 0, unavailable: 2, passing: 0, oldestAsOf: 4_000 });
  });

  it('empty cache → all zeros and oldestAsOf null', async () => {
    const { coll } = inMemoryColl([]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov).toEqual({ count: 0, covered: 0, unavailable: 0, passing: 0, oldestAsOf: null });
  });

  it('treats a legacy row with no `unavailable` field (pre-Task-7) as covered, not unavailable', async () => {
    // A row written before the tombstone field existed has `unavailable` absent/undefined. The split
    // keys off `unavailable === true`, so an absent flag reads as a real (covered) row — back-compat
    // with any pre-Task-7 doc still in the collection.
    const legacy = realRow('AAPL:US', true, 1_000);
    delete (legacy as { unavailable?: boolean }).unavailable;
    const { coll } = inMemoryColl([legacy]);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov.covered).toBe(1);
    expect(cov.unavailable).toBe(0);
    expect(cov.passing).toBe(1);
  });

  it('reproduces the live shape — 28 covered + 32 unavailable = 60 count, 19 passing', async () => {
    // The T7-QA live reality: 60 cache rows = 28 US pit-edgar real rows (19 passing QMJ) + 32
    // non-US/no-EDGAR tombstones. coverage() must report that split so feed-health/coverage read
    // honestly instead of "60 count / 19 passing" (which looked like broken coverage).
    const rows: FundamentalsDoc[] = [];
    for (let i = 0; i < 19; i++) rows.push(realRow(`PASS${i}:US`, true, 1_000 + i));   // covered + passing
    for (let i = 0; i < 9; i++) rows.push(realRow(`FAIL${i}:US`, false, 2_000 + i));   // covered, not passing (28 real total)
    for (let i = 0; i < 32; i++) rows.push(tombstone(`TOMB${i}:LSE`, 3_000 + i));       // by-design unavailable
    const { coll } = inMemoryColl(rows);
    const cache = withColl(new FundamentalsCache(noopProvider, 'pit'), coll);

    const cov = await cache.coverage();

    expect(cov.count).toBe(60);
    expect(cov.covered).toBe(28);
    expect(cov.unavailable).toBe(32);
    expect(cov.passing).toBe(19);
    expect(cov.covered + cov.unavailable).toBe(cov.count);
  });
});
