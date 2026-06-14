// FundamentalsCache tombstones + refresh convergence (RC2 core). The `[fundamentals] refresh made no
// progress (N stale)` loop was caused by `terminal` names (non-US fail-closed, no-EDGAR US misses)
// that can NEVER resolve: with no row written for them they stayed perpetually stale, so every
// background pass re-fetched them, found zero new hits, and warned forever. The fix: `refresh` writes
// a TOMBSTONE (asOf:now, unavailable:true, nulls, qualityPass:false) for each `terminal` name, which
// makes it fresh (asOf:now) so `refreshStale` stops counting it → the set converges and the scheduler
// stops warning. An `outage` name (upstream unreachable) is NOT tombstoned — it stays stale and
// retries. A later genuine `hit` overwrites the tombstone with real data.
//
// The DECISION + the Mongo writes are the unit here. A tiny in-memory company_fundamentals collection
// (id→doc Map, supporting find({_id:{$in}}) + upsert) models persistence so a SECOND pass observes the
// tombstones written by the first and proves convergence (stale → 0).

import { describe, it, expect, vi } from 'vitest';
import { FundamentalsCache } from '../modules/fundamentals/application/FundamentalsCache.ts';
import { FundamentalsRefreshScheduler } from '../modules/fundamentals/application/FundamentalsRefreshScheduler.ts';
import type { FundamentalsCache as FundamentalsCacheType, FundamentalsDoc } from '../modules/fundamentals/application/FundamentalsCache.ts';
import type { FundamentalsProvider, FundamentalsRaw, FundamentalsFetchResult } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';
import { log } from '../logger.ts';

const RAW = (mc: number): FundamentalsRaw => ({
  netIncome: 100, totalEquity: 500, totalDebt: 200, currentAssets: 300, currentLiabilities: 150, marketCapGbp: mc,
});

// In-memory company_fundamentals keyed on the '<symbol>:<market>' composite `_id`. Supports the two
// shapes the cache uses: find({ _id: { $in } }, { projection }) and updateOne(upsert). Persists each
// upsert's `$set`, so a second refresh pass sees the freshly-written tombstones.
function inMemoryColl() {
  const docs = new Map<string, Record<string, unknown>>();
  const coll = {
    find: (q: { _id?: { $in?: string[] } }, _opts?: unknown) => ({
      toArray: async () => {
        const ids = q._id?.$in;
        const all = [...docs.values()];
        return ids ? all.filter((d) => ids.includes(d._id as string)) : all;
      },
    }),
    updateOne: async (q: { _id: string }, update: { $set: Record<string, unknown> }) => {
      const prev = docs.get(q._id) ?? { _id: q._id };
      docs.set(q._id, { ...prev, ...update.$set });
      return { acknowledged: true, upsertedCount: prev._id === undefined ? 1 : 0 };
    },
  };
  return { coll, docs };
}

// Bind the in-memory collection into the cache's single DB seam (private `coll()`).
function withColl(cache: FundamentalsCache, coll: ReturnType<typeof inMemoryColl>['coll']): FundamentalsCache {
  (cache as unknown as { coll: () => Promise<typeof coll> }).coll = async () => coll;
  return cache;
}

// A provider that returns a fixed classification map. `values` carries only the `hit` names (real
// fundamentals); `status` carries one entry per requested ticker — exactly the Task 6 contract.
function provider(
  classify: (ticker: string) => 'hit' | 'terminal' | 'outage',
  mc = 3_000_000,
): FundamentalsProvider {
  return {
    fetch: async (tickers: string[]): Promise<FundamentalsFetchResult> => {
      const values: Record<string, FundamentalsRaw> = {};
      const status: Record<string, 'hit' | 'terminal' | 'outage'> = {};
      for (const t of tickers) {
        const s = classify(t);
        status[t] = s;
        if (s === 'hit') values[t] = RAW(mc);
      }
      return { values, status };
    },
  };
}

describe('FundamentalsCache.refresh — tombstones for terminal names', () => {
  it('writes a tombstone (asOf:now, unavailable:true, nulls, qualityPass:false) for a non-US + a no-EDGAR US name; a hit stays a real row', async () => {
    const { coll, docs } = inMemoryColl();
    // AAPL (US) hits; VOD (LSE, non-US → terminal) and TCEHY (US no-EDGAR → terminal) are tombstoned.
    const p = provider((t) => (t.startsWith('AAPL') ? 'hit' : 'terminal'));
    const cache = withColl(new FundamentalsCache(p, 'pit'), coll);

    const written = await cache.refresh(['AAPL_US_EQ', 'VODl_EQ', 'TCEHY_US_EQ']);

    // refresh() returns ONLY the real-hit count — a tombstone is not a "covered" name.
    expect(written).toBe(1);

    // AAPL — a real row: raw present, source stamped, unavailable explicitly false.
    const aapl = docs.get('AAPL:US')!;
    expect(aapl.unavailable).toBe(false);
    expect(aapl.qualityPass).toBe(true);
    expect(aapl.raw).not.toBeNull();
    expect(aapl.source).toBe('pit');   // no sourceOf on this provider → configured mode

    // VOD (LSE) + TCEHY (US) — tombstones: every payload field null, unavailable:true, qualityPass:false.
    for (const id of ['VOD:LSE', 'TCEHY:US']) {
      const tomb = docs.get(id)!;
      expect(tomb.unavailable).toBe(true);
      expect(tomb.raw).toBeNull();
      expect(tomb.ratios).toBeNull();
      expect(tomb.marketCapGbp).toBeNull();
      expect(tomb.source).toBeNull();
      expect(tomb.qualityPass).toBe(false);
      expect(typeof tomb.asOf).toBe('number'); // asOf:now — what makes it leave the stale set
    }
  });

  it('does NOT tombstone an outage name — it is left untouched to retry next cycle', async () => {
    const { coll, docs } = inMemoryColl();
    const p = provider(() => 'outage');   // whole batch unreachable
    const cache = withColl(new FundamentalsCache(p, 'pit'), coll);

    const written = await cache.refresh(['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(written).toBe(0);
    expect(docs.size).toBe(0);   // no tombstone, no row — the names stay missing → still stale → retry
  });

  it('a later hit overwrites a prior tombstone with real data (unavailable flips false)', async () => {
    const { coll, docs } = inMemoryColl();

    // Pass 1: TCEHY is terminal → tombstone.
    await withColl(new FundamentalsCache(provider(() => 'terminal'), 'pit'), coll).refresh(['TCEHY_US_EQ']);
    expect(docs.get('TCEHY:US')!.unavailable).toBe(true);
    expect(docs.get('TCEHY:US')!.raw).toBeNull();

    // Pass 2: same name now resolves (a CIK appeared / coverage filled) → hit overwrites the tombstone.
    await withColl(new FundamentalsCache(provider(() => 'hit'), 'pit'), coll).refresh(['TCEHY_US_EQ']);
    const row = docs.get('TCEHY:US')!;
    expect(row.unavailable).toBe(false);
    expect(row.raw).not.toBeNull();
    expect(row.qualityPass).toBe(true);
    expect(row.source).toBe('pit');
  });
});

describe('FundamentalsCache.refreshStale — convergence (the loop drains the stale set)', () => {
  it('a non-US + a no-EDGAR US name converge after ONE pass: terminal → tombstoned, then no longer stale', async () => {
    const { coll } = inMemoryColl();
    const tickers = ['VODl_EQ', 'TCEHY_US_EQ'];                 // both terminal — can never resolve
    const cache = withColl(new FundamentalsCache(provider(() => 'terminal'), 'pit'), coll);

    // Pass 1: both are stale (no row), both tombstoned. refreshed counts tombstones as progress; no outage.
    const pass1 = await cache.refreshStale(tickers);
    expect(pass1).toEqual({ stale: 2, refreshed: 2, outage: 0 });

    // Pass 2: the tombstones are asOf:now (fresh), so NOTHING is stale — the set has converged.
    const pass2 = await cache.refreshStale(tickers);
    expect(pass2).toEqual({ stale: 0, refreshed: 0, outage: 0 });
  });

  it('an outage name stays stale and is re-attempted next pass (never converges while the upstream is down)', async () => {
    const { coll } = inMemoryColl();
    const cache = withColl(new FundamentalsCache(provider(() => 'outage'), 'pit'), coll);

    const pass1 = await cache.refreshStale(['AAPL_US_EQ']);
    expect(pass1).toEqual({ stale: 1, refreshed: 0, outage: 1 });
    // Still stale next pass — an outage is not tombstoned, so it keeps retrying.
    const pass2 = await cache.refreshStale(['AAPL_US_EQ']);
    expect(pass2).toEqual({ stale: 1, refreshed: 0, outage: 1 });
  });
});

describe('FundamentalsRefreshScheduler — warns ONLY on a genuine outage, not an all-terminal residual', () => {
  // Drive ONE scheduler pass by stubbing the cache's refreshStale, and capture log.warn to assert the
  // "made no progress" warning fires exactly when ≥1 name was a real outage.
  async function runOnePass(stub: Awaited<ReturnType<FundamentalsCache['refreshStale']>>): Promise<{ warned: boolean }> {
    const cache = { refreshStale: vi.fn(async () => stub) } as unknown as FundamentalsCache;
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const sched = new FundamentalsRefreshScheduler(cache, () => ['X_US_EQ']);
    // loop() runs forever; run a single iteration by invoking the private method then stopping it.
    const loop = (sched as unknown as { loop: () => Promise<void> }).loop.bind(sched);
    (sched as unknown as { running: boolean }).running = true;
    const p = loop();
    // Let the first iteration execute its refreshStale + branch, then stop before the sleep resolves.
    await new Promise((r) => setImmediate(r));
    (sched as unknown as { running: boolean }).running = false;
    sched.triggerNow();   // wake the interruptible sleep so loop() exits its single iteration
    await p;
    const warned = warn.mock.calls.some((c) => String(c[0]).includes('made no progress'));
    warn.mockRestore();
    return { warned };
  }

  it('does NOT warn when the residual stale set is all-terminal (tombstoned this pass, 0 outage)', async () => {
    const { warned } = await runOnePass({ stale: 32, refreshed: 32, outage: 0 });
    expect(warned).toBe(false);   // 32 names just got tombstoned — progress, not a warning
  });

  it('warns when nothing advanced AND ≥1 name was a genuine outage', async () => {
    const { warned } = await runOnePass({ stale: 5, refreshed: 0, outage: 5 });
    expect(warned).toBe(true);
  });

  it('does NOT warn on a mixed pass (some hits/tombstones written, some outage remaining)', async () => {
    const { warned } = await runOnePass({ stale: 10, refreshed: 7, outage: 3 });
    expect(warned).toBe(false);   // progress was made; the outage subset just keeps retrying
  });
});

// Compile-time guard: a tombstone's nulls + the `unavailable` flag are valid FundamentalsDoc shapes,
// and a real row keeps its non-null raw/source — the type the route + scanner read defensively.
const _tombstoneShape: FundamentalsDoc = {
  _id: 'TCEHY:US', symbol: 'TCEHY', market: 'US', asOf: 1, raw: null, ratios: null,
  qualityPass: false, marketCapGbp: null, source: null, unavailable: true, updatedAt: 1,
};
const _realShape: FundamentalsDoc = {
  _id: 'AAPL:US', symbol: 'AAPL', market: 'US', asOf: 1, raw: RAW(1), ratios: null,
  qualityPass: true, marketCapGbp: 1, source: 'pit-edgar', updatedAt: 1,
};
void (_tombstoneShape satisfies FundamentalsDoc);
void (_realShape satisfies FundamentalsDoc);
void (null as unknown as FundamentalsCacheType);
