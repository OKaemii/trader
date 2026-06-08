// CorporateActionsWatcher — Gap 1 (plan §8): a NEW split/dividend re-adjusts the seeded daily series
// so it never drifts onto a stale adjustment basis (the discontinuity that injects a fake return
// spike). Four behaviours the requirement names, in layers:
//   1. a new split for a ticker triggers a forceRefetch re-backfill (and the default path really calls
//      backfillDailyHistory with { forceRefetch: true });
//   2. an already-seen event is a no-op (the store never fires the hook → no re-adjust);
//   3. limiter exhaustion degrades cleanly — the default re-adjust returns a per-ticker {error}, the
//      watcher swallows it (no throw), and the sync loop is unaffected;
//   4. after a re-adjust, the prior daily revisions are SUPERSEDED — the now-latest series is the
//      provider's re-adjusted closes, with no |log-return| spike across the split date.
//
// The store reaches getMongoDb() internally for its doc, so we mock shared-mongo with an in-memory
// collection (the only surface the store touches) before importing the store — mirroring
// corporate-actions.test.ts. Layer 4 drives the REAL writeBarRevisions through its own mongo stub.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Db } from 'mongodb';
import type { RedisClientType } from 'redis';
import type { OHLCVBar } from '@trader/shared-types';

// ── In-memory Mongo for the store's per-ticker doc (the only surface it uses) ────────────────────
interface AnyDoc { _id: string; [k: string]: unknown }
class FakeCollection {
  rows = new Map<string, AnyDoc>();
  async findOne(filter: { _id: string }): Promise<AnyDoc | null> { return this.rows.get(filter._id) ?? null; }
  find(filter: { _id: { $in: string[] } }) {
    const set = new Set(filter._id.$in);
    return { toArray: async () => Array.from(this.rows.values()).filter((r) => set.has(r._id)) };
  }
  async countDocuments(): Promise<number> { return this.rows.size; }
  async updateOne(filter: { _id: string }, update: { $set: Record<string, unknown> }) {
    const prev = this.rows.get(filter._id) ?? { _id: filter._id };
    this.rows.set(filter._id, { ...prev, ...update.$set });
  }
}
const fakeColl = new FakeCollection();

// getMongoClient is needed by writeBarRevisions (Layer 4) to start a transaction session — the stub
// session runs its withTransaction callback directly (no real transaction semantics needed; we test
// the supersede decision tree, not Mongo's guarantees), mirroring persist-bars.test.ts.
const sessionStub = {
  withTransaction: async (fn: () => Promise<void>) => { await fn(); },
  endSession: async () => {},
};
vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { CORPORATE_ACTIONS: 'corporate_actions', OHLCV_BARS: 'ohlcv_bars', BAR_REVISIONS_LOG: 'bar_revisions_log' },
  getMongoDb: async () => ({ collection: () => fakeColl }),
  getMongoClient: async () => ({ startSession: () => sessionStub }),
}));

// Mock the daily-history backfill so the DEFAULT re-adjust path is observable without an upstream
// round-trip — assert it's invoked with { forceRefetch: true }, and script its result (incl. the
// limiter-exhaustion {error} degrade). vi.hoisted: the factory is hoisted above the const.
const { backfillMock } = vi.hoisted(() => ({
  backfillMock: vi.fn(async (_db: unknown, _redis: unknown, tickers: string[]) =>
    tickers.map((t) => ({ ticker: t, fetched: 1, upserted: 1 }))),
}));
vi.mock('../modules/bars/infrastructure/daily-history.ts', () => ({
  backfillDailyHistory: backfillMock,
}));

const { CorporateActionsStore } = await import('../modules/corporate-actions/application/CorporateActionsStore.ts');
const { CorporateActionsWatcher } = await import('../modules/corporate-actions/application/CorporateActionsWatcher.ts');
import type { CorporateActionsProvider, ProviderDividend, ProviderSplit } from '../modules/corporate-actions/infrastructure/CorporateActionsProvider.ts';

const ms = (iso: string) => Date.parse(iso);

// A provider returning scripted events (the store turns these into "new" actions on first sight).
class FakeProvider implements CorporateActionsProvider {
  constructor(
    private readonly dividends: (t: string, from?: string) => ProviderDividend[] = () => [],
    private readonly splits: (t: string, from?: string) => ProviderSplit[] = () => [],
  ) {}
  async fetchDividends(t: string, from?: string): Promise<ProviderDividend[]> { return this.dividends(t, from); }
  async fetchSplits(t: string, from?: string): Promise<ProviderSplit[]> { return this.splits(t, from); }
}

// Lazy resolvers handed to the watcher — these stand in for the real Mongo/Redis singletons. The
// DEFAULT re-adjust path only forwards them to the (mocked) backfill, so plain sentinels suffice.
const deps = {
  getDb: async () => ({}) as unknown as Db,
  getRedis: async () => ({}) as unknown as RedisClientType,
};

beforeEach(() => {
  fakeColl.rows.clear();
  backfillMock.mockClear();
  backfillMock.mockImplementation(async (_db: unknown, _redis: unknown, tickers: string[]) =>
    tickers.map((t) => ({ ticker: t, fetched: 1, upserted: 1 })));
});

// ── 1. A new split triggers a forced re-backfill ─────────────────────────────────────────────────
describe('CorporateActionsWatcher — new action triggers a re-adjust', () => {
  it('fires the re-adjust for a ticker whose sync appends a previously-unseen split', async () => {
    const reAdjusted: string[] = [];
    const watcher = new CorporateActionsWatcher(deps, {
      spacingMs: 0,
      reAdjust: async (ticker) => { reAdjusted.push(ticker); },
    });
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '2/1', factor: 2 }]),
      'eodhd', undefined, watcher.onNewActions,
    );

    const r = await store.syncOne('AAPL_US_EQ', ms('2025-06-11'));
    await watcher.idle();

    expect(r.newSplits).toBe(1);
    expect(reAdjusted).toEqual(['AAPL_US_EQ']);   // the new split triggered exactly one re-adjust
  });

  it('also fires on a new dividend (not only splits)', async () => {
    const reAdjusted: string[] = [];
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0, reAdjust: async (t) => { reAdjusted.push(t); } });
    const store = new CorporateActionsStore(
      new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []),
      'eodhd', undefined, watcher.onNewActions,
    );
    await store.syncOne('MSFT_US_EQ', ms('2025-06-01'));
    await watcher.idle();
    expect(reAdjusted).toEqual(['MSFT_US_EQ']);
  });

  it('the DEFAULT re-adjust path calls backfillDailyHistory with { forceRefetch: true } for that ticker', async () => {
    // No `reAdjust` override → exercise the real default (mocked backfill). This is the precise
    // contract: a re-adjust is a forced (whole-span) re-fetch so writeBarRevisions supersedes the
    // stale-adjusted rows with the provider's re-adjusted series.
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0 });
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '4/1', factor: 4 }]),
      'eodhd', undefined, watcher.onNewActions,
    );

    await store.syncOne('NVDA_US_EQ', ms('2025-06-11'));
    await watcher.idle();

    expect(backfillMock).toHaveBeenCalledTimes(1);
    const [, , tickers, opts] = backfillMock.mock.calls[0]!;
    expect(tickers).toEqual(['NVDA_US_EQ']);
    expect(opts).toEqual({ forceRefetch: true });
  });
});

// ── 2. An already-seen event is a no-op ──────────────────────────────────────────────────────────
describe('CorporateActionsWatcher — an already-seen event is a no-op', () => {
  it('does not re-adjust when a re-sync within the TTL surfaces nothing new', async () => {
    const reAdjusted: string[] = [];
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0, reAdjust: async (t) => { reAdjusted.push(t); } });
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '2/1', factor: 2 }]),
      'eodhd', undefined, watcher.onNewActions,
    );
    const t0 = ms('2025-06-11');
    await store.syncOne('AAPL_US_EQ', t0);            // first sight → one re-adjust
    await watcher.idle();
    expect(reAdjusted).toEqual(['AAPL_US_EQ']);

    // Re-sync a few hours later (within the 24h TTL): the store short-circuits before any fetch, so
    // the hook never fires again — no second re-adjust.
    const r = await store.syncOne('AAPL_US_EQ', t0 + 3 * 60 * 60 * 1000);
    await watcher.idle();
    expect(r).toEqual({ fetched: false, newDividends: 0, newSplits: 0 });
    expect(reAdjusted).toEqual(['AAPL_US_EQ']);       // STILL just the one — no re-adjust on a no-op
  });

  it('does not re-adjust when a past-TTL re-fetch returns only already-stored events (idempotent)', async () => {
    const reAdjusted: string[] = [];
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0, reAdjust: async (t) => { reAdjusted.push(t); } });
    // TTL 0 → always fetches; the provider keeps returning the same split it already stored.
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '2/1', factor: 2 }]),
      'eodhd', /* ttlMs */ 0, watcher.onNewActions,
    );
    const t0 = ms('2025-06-11');
    await store.syncOne('AAPL_US_EQ', t0);            // first sight → re-adjust
    const r = await store.syncOne('AAPL_US_EQ', t0 + 1000);   // same event back → appends nothing
    await watcher.idle();

    expect(r.fetched).toBe(true);
    expect(r.newSplits).toBe(0);                       // nothing new
    expect(reAdjusted).toEqual(['AAPL_US_EQ']);        // re-adjusted once only — the re-fetch was a no-op
    expect(backfillMock).not.toHaveBeenCalled();       // (override used, default never reached)
  });
});

// ── 3. Limiter exhaustion degrades cleanly ───────────────────────────────────────────────────────
describe('CorporateActionsWatcher — limiter exhaustion degrades cleanly', () => {
  it('a backfill that returns a per-ticker {error} (budget gone) does not throw or break the sync', async () => {
    // backfillDailyHistory never throws on limiter exhaustion — it returns a per-ticker {error}
    // (the EODHD client degraded to empty). The watcher must log + move on, NOT propagate.
    backfillMock.mockImplementation(async (_db: unknown, _redis: unknown, tickers: string[]) =>
      tickers.map((t) => ({ ticker: t, fetched: 0, upserted: 0, error: 'EODHD daily call budget exhausted' })));

    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0 });   // default path → mocked backfill
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '2/1', factor: 2 }]),
      'eodhd', undefined, watcher.onNewActions,
    );

    // The sync itself must resolve normally (the hook is best-effort), and the drain must settle.
    const r = await store.syncOne('AAPL_US_EQ', ms('2025-06-11'));
    await expect(watcher.idle()).resolves.toBeUndefined();
    expect(r.newSplits).toBe(1);                       // the store still recorded the action
    expect(backfillMock).toHaveBeenCalledTimes(1);     // a re-adjust was attempted (and degraded)
  });

  it('a re-adjust that THROWS is isolated — the store sync still resolves', async () => {
    backfillMock.mockRejectedValue(new Error('mongo blip mid-reback'));
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0 });
    const store = new CorporateActionsStore(
      new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []),
      'eodhd', undefined, watcher.onNewActions,
    );
    // syncOne must not reject even though the bound re-adjust rejects (store swallows the hook error).
    const r = await store.syncOne('AAPL_US_EQ', ms('2025-06-01'));
    await expect(watcher.idle()).resolves.toBeUndefined();
    expect(r.newDividends).toBe(1);
  });
});

// ── Burst handling: a market-wide split day fans out, deduped + spread ────────────────────────────
describe('CorporateActionsWatcher — burst handling', () => {
  it('dedupes a synchronous burst of the same ticker into a single re-adjust', async () => {
    // Two hooks for the same ticker fire back-to-back (as the EOD sync loop would). The drain start
    // is deferred one microtask, so both land in the pending Set BEFORE the drain pops anything → the
    // Set collapses them to one re-adjust. No redundant whole-span re-fetch of the same ticker.
    let calls = 0;
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0, reAdjust: async () => { calls++; } });
    watcher.onNewActions('AAPL_US_EQ', { newDividends: 0, newSplits: 1 });
    watcher.onNewActions('AAPL_US_EQ', { newDividends: 1, newSplits: 0 });   // same ticker again
    await watcher.idle();
    expect(calls).toBe(1);
  });

  it('drains many distinct tickers from one burst (each re-adjusted once)', async () => {
    const seen: string[] = [];
    const watcher = new CorporateActionsWatcher(deps, { spacingMs: 0, reAdjust: async (t) => { seen.push(t); } });
    for (const t of ['AAPL_US_EQ', 'MSFT_US_EQ', 'NVDA_US_EQ']) {
      watcher.onNewActions(t, { newDividends: 0, newSplits: 1 });
    }
    await watcher.idle();
    expect(seen.sort()).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ', 'NVDA_US_EQ']);
  });
});

// ── 4. After a re-adjust, prior revisions are SUPERSEDED (no |log-return| spike) ──────────────────
// This wires the real writeBarRevisions so the bi-temporal supersede contract is exercised end-to-end
// for the re-adjust: a 2:1 split lands; the stale-adjusted history (pre-split closes NOT halved) has a
// fake 2x jump at the split date; the re-adjust feeds the provider's re-adjusted series (pre-split
// closes halved) through writeBarRevisions, which supersedes the stale rows. The now-latest series has
// no |log-return| spike across the split.
describe('CorporateActionsWatcher — re-adjust supersedes stale revisions (no split-date return spike)', () => {
  // A minimal in-memory ohlcv_bars + audit pair with the surface writeBarRevisions touches, tracking
  // is_superseded so we can read back the "latest" (unsuperseded) series after the re-adjust.
  function makeBarsDb() {
    interface Row { ticker: string; observation_ts: number; interval: string; close: number; content_hash: string; is_superseded: boolean; knowledge_ts: number }
    const rows: Row[] = [];
    const audits: Array<Record<string, unknown>> = [];
    const ohlcv = {
      find: (filter: { $or: Array<{ ticker: string; observation_ts: number; interval: string }>; is_superseded: boolean }) => {
        const keys = new Set(filter.$or.map((k) => `${k.ticker}|${k.observation_ts}|${k.interval}`));
        const matched = rows.filter((r) => !r.is_superseded && keys.has(`${r.ticker}|${r.observation_ts}|${r.interval}`));
        return { project: () => ({ toArray: async () => matched }), toArray: async () => matched };
      },
      updateMany: async (filter: { ticker: string; observation_ts: number; interval: string }, update: { $set: { is_superseded: boolean } }) => {
        let n = 0;
        for (const r of rows) {
          if (r.ticker === filter.ticker && r.observation_ts === filter.observation_ts && r.interval === filter.interval && !r.is_superseded) {
            r.is_superseded = update.$set.is_superseded; n++;
          }
        }
        return { acknowledged: true, modifiedCount: n };
      },
      insertOne: async (doc: Record<string, unknown>) => {
        rows.push({
          ticker: doc.ticker as string, observation_ts: doc.observation_ts as number, interval: doc.interval as string,
          close: doc.close as number, content_hash: doc.content_hash as string,
          is_superseded: doc.is_superseded as boolean, knowledge_ts: doc.knowledge_ts as number,
        });
        return { acknowledged: true, insertedId: 'x' };
      },
    };
    const auditColl = { insertOne: async (d: Record<string, unknown>) => { audits.push(d); return { acknowledged: true, insertedId: 'x' }; } };
    const db = { collection: (n: string) => (n === 'ohlcv_bars' ? ohlcv : auditColl) } as unknown as Db;
    // Latest (unsuperseded) close series for a ticker, oldest-first.
    const latestSeries = (ticker: string): number[] =>
      rows.filter((r) => r.ticker === ticker && !r.is_superseded).sort((a, b) => a.observation_ts - b.observation_ts).map((r) => r.close);
    return { db, rows, audits, latestSeries };
  }

  // Largest absolute day-over-day log return across a close series (the discontinuity detector).
  const maxAbsLogReturn = (closes: number[]): number => {
    let max = 0;
    for (let i = 1; i < closes.length; i++) {
      const lr = Math.abs(Math.log(closes[i]! / closes[i - 1]!));
      if (lr > max) max = lr;
    }
    return max;
  };

  const dailyBar = (ticker: string, iso: string, close: number): OHLCVBar => ({
    ticker, observation_ts: ms(iso), timestamp: ms(iso), interval: 'daily',
    open: close, high: close, low: close, close, volume: 1_000,
    rawClose: close, adjustedClose: close, adjustmentFactor: 1,
  });

  it('the stale-adjusted series has a fake 2x spike that the re-adjust removes by superseding the old rows', async () => {
    const { db, latestSeries } = makeBarsDb();
    const { writeBarRevisions } = await import('../modules/bars/infrastructure/persist-bars.ts');

    // A flat ~$100 stock that does a 2:1 split on 06-10. The provider's adjusted close halves every
    // PRE-split bar (so the series is continuous), but the STALE seed left pre-split closes at ~$100
    // and post-split at ~$50 — a 2x cliff at the split.
    const dates = ['2025-06-06', '2025-06-09', '2025-06-10', '2025-06-11', '2025-06-12'];
    const staleCloses = [100, 100, 50, 50, 50];   // pre-split NOT halved → discontinuity at 06-10
    const stale = dates.map((d, i) => dailyBar('SPLIT_US_EQ', d, staleCloses[i]!));
    await writeBarRevisions(db, stale, 'daily', 1_000);

    // Sanity: the stale series has a large jump (|ln(50/100)| ≈ 0.693) — the fake spike.
    expect(maxAbsLogReturn(latestSeries('SPLIT_US_EQ'))).toBeGreaterThan(0.6);

    // The re-adjust feeds the provider's re-adjusted series (pre-split halved → fully continuous at
    // ~$50). Bind the watcher's reAdjust to push these through the same writeBarRevisions, exactly
    // as the production default does via backfillDailyHistory → writeBarRevisions.
    const reAdjustedCloses = [50, 50, 50, 50, 50];
    const watcher = new CorporateActionsWatcher(deps, {
      spacingMs: 0,
      reAdjust: async (ticker) => {
        const fixed = dates.map((d, i) => dailyBar(ticker, d, reAdjustedCloses[i]!));
        await writeBarRevisions(db, fixed, 'daily', 2_000);   // later knowledge_ts → supersedes
      },
    });

    // A new split lands → the store fires the hook → the re-adjust runs.
    const store = new CorporateActionsStore(
      new FakeProvider(() => [], () => [{ date: '2025-06-10', ratio: '2/1', factor: 2 }]),
      'eodhd', undefined, watcher.onNewActions,
    );
    await store.syncOne('SPLIT_US_EQ', ms('2025-06-13'));
    await watcher.idle();

    // The now-latest (unsuperseded) series is the re-adjusted one: flat $50 → NO |log-return| spike.
    const latest = latestSeries('SPLIT_US_EQ');
    expect(latest).toEqual([50, 50, 50, 50, 50]);
    expect(maxAbsLogReturn(latest)).toBeLessThan(1e-9);   // continuous across the split date
  });
});
