// Corporate-actions module: the pure dividend-yield + price-at-asOf computations, and the store's
// INCREMENTAL sync — most importantly the §I guarantee that a re-sync of a current ticker makes ZERO
// upstream EODHD calls. The store reaches getMongoDb() internally, so we mock shared-mongo with an
// in-memory collection (the only surface the store touches) before importing the store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { OHLCVBar } from '@trader/shared-types';

// ── In-memory Mongo (only the surface CorporateActionsStore uses) ───────────────────────────────
interface AnyDoc { _id: string; [k: string]: unknown }
class FakeCollection {
  rows = new Map<string, AnyDoc>();
  async findOne(filter: { _id: string }): Promise<AnyDoc | null> {
    return this.rows.get(filter._id) ?? null;
  }
  find(filter: { _id: { $in: string[] } }) {
    const set = new Set(filter._id.$in);
    const list = Array.from(this.rows.values()).filter((r) => set.has(r._id));
    return { toArray: async () => list };
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    if (Object.keys(filter).length === 0) return this.rows.size;
    const key = Object.keys(filter)[0]!;          // 'dividends.0' | 'splits.0'
    const arr = key.split('.')[0]!;
    return Array.from(this.rows.values()).filter((r) => Array.isArray(r[arr]) && (r[arr] as unknown[]).length > 0).length;
  }
  async updateOne(filter: { _id: string }, update: { $set: Record<string, unknown> }, _opts: { upsert: boolean }) {
    const prev = this.rows.get(filter._id) ?? { _id: filter._id };
    this.rows.set(filter._id, { ...prev, ...update.$set });
  }
}
const fakeColl = new FakeCollection();

vi.mock('@trader/shared-mongo', () => ({
  COLLECTIONS: { CORPORATE_ACTIONS: 'corporate_actions' },
  getMongoDb: async () => ({ collection: () => fakeColl }),
}));

const { CorporateActionsStore } = await import('../modules/corporate-actions/application/CorporateActionsStore.ts');
const { trailingDividendPerShare, dividendYieldAsOf } = await import('../modules/corporate-actions/application/dividend-yield.ts');
const { closeAtOrBefore } = await import('../modules/corporate-actions/application/price-at.ts');
import type { CorporateActionsProvider, ProviderDividend, ProviderSplit } from '../modules/corporate-actions/infrastructure/CorporateActionsProvider.ts';
import { EodhdCorporateActionsProvider } from '../modules/corporate-actions/infrastructure/CorporateActionsProvider.ts';
import { EodhdClient, _setEodhdClientForTest, type EodhdDividendEvent, type EodhdSplitEvent } from '../modules/bars/infrastructure/providers/eodhd-client.ts';

const MS_DAY = 24 * 60 * 60 * 1000;
const ms = (iso: string) => Date.parse(iso);

// A provider that records every call (so we can assert zero calls) and returns scripted events.
class FakeProvider implements CorporateActionsProvider {
  divCalls: Array<{ ticker: string; from?: string }> = [];
  splitCalls: Array<{ ticker: string; from?: string }> = [];
  constructor(
    private readonly dividends: (ticker: string, from?: string) => ProviderDividend[] = () => [],
    private readonly splits: (ticker: string, from?: string) => ProviderSplit[] = () => [],
  ) {}
  async fetchDividends(ticker: string, from?: string): Promise<ProviderDividend[]> {
    this.divCalls.push({ ticker, ...(from ? { from } : {}) });
    return this.dividends(ticker, from);
  }
  async fetchSplits(ticker: string, from?: string): Promise<ProviderSplit[]> {
    this.splitCalls.push({ ticker, ...(from ? { from } : {}) });
    return this.splits(ticker, from);
  }
}

beforeEach(() => { fakeColl.rows.clear(); });

// ── Pure: trailing dividend-per-share ───────────────────────────────────────────────────────────
describe('trailingDividendPerShare', () => {
  const divs = [
    { date: '2025-02-01', valuePerShare: 0.5 },
    { date: '2025-05-01', valuePerShare: 0.5 },
    { date: '2025-08-01', valuePerShare: 0.6 },
    { date: '2025-11-01', valuePerShare: 0.6 },
  ];

  it('sums only ex-dates in the trailing 12 months at/<= asOf', () => {
    // as-of 2025-12-01: all four in (2024-12-01, 2025-12-01] → 0.5+0.5+0.6+0.6 = 2.2
    expect(trailingDividendPerShare(divs, ms('2025-12-01'))).toBeCloseTo(2.2, 10);
  });

  it('excludes dividends whose ex-date is after asOf (no look-ahead)', () => {
    // as-of 2025-06-01: only Feb + May count (Aug/Nov are future) → 1.0
    expect(trailingDividendPerShare(divs, ms('2025-06-01'))).toBeCloseTo(1.0, 10);
  });

  it('drops events older than the trailing year', () => {
    // as-of 2026-03-01: window start 2025-03-01 → May/Aug/Nov count, Feb drops → 1.7
    expect(trailingDividendPerShare(divs, ms('2026-03-01'))).toBeCloseTo(1.7, 10);
  });

  it('returns 0 for a non-payer (finite, not NaN)', () => {
    expect(trailingDividendPerShare([], ms('2025-12-01'))).toBe(0);
  });

  it('skips negative / non-finite values', () => {
    const bad = [{ date: '2025-06-01', valuePerShare: -1 }, { date: '2025-07-01', valuePerShare: NaN }];
    expect(trailingDividendPerShare(bad, ms('2025-12-01'))).toBe(0);
  });
});

// ── Pure: dividend yield as-of ──────────────────────────────────────────────────────────────────
describe('dividendYieldAsOf', () => {
  const divs = [{ date: '2025-06-01', valuePerShare: 2 }, { date: '2025-12-01', valuePerShare: 2 }];

  it('is trailing DPS / price, unit-consistent', () => {
    // ttm at 2025-12-01 = 4; price 100 → 0.04
    expect(dividendYieldAsOf(divs, 100, ms('2025-12-01'))).toBeCloseTo(0.04, 10);
  });

  it('returns null (not 0) when the price is missing / non-positive', () => {
    expect(dividendYieldAsOf(divs, null, ms('2025-12-01'))).toBeNull();
    expect(dividendYieldAsOf(divs, 0, ms('2025-12-01'))).toBeNull();
    expect(dividendYieldAsOf(divs, -5, ms('2025-12-01'))).toBeNull();
  });

  it('yields a finite 0 for a non-payer with a real price', () => {
    expect(dividendYieldAsOf([], 100, ms('2025-12-01'))).toBe(0);
  });
});

// ── Pure: close at/<= asOf ──────────────────────────────────────────────────────────────────────
describe('closeAtOrBefore', () => {
  const bar = (iso: string, close: number): OHLCVBar => ({
    ticker: 'X', observation_ts: ms(iso), open: close, high: close, low: close, close, volume: 1, interval: 'daily',
  });

  it('returns the latest close at/<= asOf, ignoring future bars', () => {
    const bars = [bar('2025-01-01', 10), bar('2025-06-01', 20), bar('2025-12-01', 30)];
    expect(closeAtOrBefore(bars, ms('2025-06-15'))).toBe(20);
  });

  it('returns null when every bar is in the future', () => {
    expect(closeAtOrBefore([bar('2025-12-01', 30)], ms('2025-01-01'))).toBeNull();
  });

  it('skips non-finite / non-positive closes', () => {
    const bars = [bar('2025-01-01', 10), { ...bar('2025-06-01', 0), close: 0 }];
    expect(closeAtOrBefore(bars, ms('2025-12-01'))).toBe(10);
  });
});

// ── Store: incremental sync ─────────────────────────────────────────────────────────────────────
describe('CorporateActionsStore incremental sync', () => {
  it('first sync of a fresh ticker fetches full history (no `from` cursor) and stores it', async () => {
    const provider = new FakeProvider(
      () => [{ date: '2025-02-01', valuePerShare: 0.5 }, { date: '2025-05-01', valuePerShare: 0.5 }],
      () => [{ date: '2024-06-01', ratio: '2/1', factor: 2 }],
    );
    const store = new CorporateActionsStore(provider, 'eodhd');
    const r = await store.syncOne('AAPL_US_EQ', ms('2025-06-01'));

    expect(r).toEqual({ fetched: true, newDividends: 2, newSplits: 1 });
    expect(provider.divCalls).toEqual([{ ticker: 'AAPL_US_EQ' }]);     // no `from` on first fetch
    expect(provider.splitCalls).toEqual([{ ticker: 'AAPL_US_EQ' }]);
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.dividends.map((d) => d.date)).toEqual(['2025-02-01', '2025-05-01']);
    expect(doc?.lastDividendDate).toBe('2025-05-01');
    expect(doc?.lastSplitDate).toBe('2024-06-01');
  });

  it('THE no-op: a re-sync within the TTL with no new actions makes ZERO upstream calls', async () => {
    const provider = new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []);
    const store = new CorporateActionsStore(provider, 'eodhd');
    const t0 = ms('2025-06-01');
    await store.syncOne('AAPL_US_EQ', t0);          // first sync populates + cursors
    const callsAfterFirst = provider.divCalls.length + provider.splitCalls.length;

    // Re-sync a few hours later (within the 24h TTL): the gate must short-circuit BEFORE any fetch.
    const r = await store.syncOne('AAPL_US_EQ', t0 + 3 * 60 * 60 * 1000);
    expect(r).toEqual({ fetched: false, newDividends: 0, newSplits: 0 });
    expect(provider.divCalls.length + provider.splitCalls.length).toBe(callsAfterFirst);   // no new calls
  });

  it('a re-sync past the TTL fetches only events after the stored cursor and appends new ones', async () => {
    let divEvents: ProviderDividend[] = [{ date: '2025-05-01', valuePerShare: 0.5 }];
    const provider = new FakeProvider((_t, _from) => divEvents, () => []);
    const store = new CorporateActionsStore(provider, 'eodhd');
    const t0 = ms('2025-06-01');
    await store.syncOne('AAPL_US_EQ', t0);

    // A new dividend lands; re-sync a day+ later. The store passes its cursor as `from`.
    divEvents = [{ date: '2025-08-01', valuePerShare: 0.6 }];
    const r = await store.syncOne('AAPL_US_EQ', t0 + MS_DAY + 1000);

    expect(r.fetched).toBe(true);
    expect(r.newDividends).toBe(1);
    const lastDivCall = provider.divCalls.at(-1)!;
    expect(lastDivCall.from).toBe('2025-05-01');         // cursor = last stored ex-date
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.dividends.map((d) => d.date)).toEqual(['2025-05-01', '2025-08-01']);
    expect(doc?.lastDividendDate).toBe('2025-08-01');
  });

  it('is idempotent — a re-fetch returning an already-stored date appends nothing', async () => {
    const provider = new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []);
    const store = new CorporateActionsStore(provider, 'eodhd', /* ttlMs */ 0);   // TTL 0 → always fetch
    const t0 = ms('2025-06-01');
    await store.syncOne('AAPL_US_EQ', t0);
    const r = await store.syncOne('AAPL_US_EQ', t0 + 1000);    // same event comes back
    expect(r.fetched).toBe(true);
    expect(r.newDividends).toBe(0);
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.dividends).toHaveLength(1);
  });

  it('syncMany reports how many tickers actually hit upstream (current ones cost nothing)', async () => {
    const provider = new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []);
    const store = new CorporateActionsStore(provider, 'eodhd');
    const t0 = ms('2025-06-01');
    await store.syncOne('AAPL_US_EQ', t0);            // AAPL now current
    const before = provider.divCalls.length;
    const agg = await store.syncMany(['AAPL_US_EQ', 'MSFT_US_EQ'], t0 + 60_000);
    // AAPL skipped (within TTL), MSFT fetched once.
    expect(agg.fetched).toBe(1);
    expect(provider.divCalls.length).toBe(before + 1);
  });

  it('dividendsForMany returns stored dividends per ticker without fetching', async () => {
    const provider = new FakeProvider(() => [{ date: '2025-05-01', valuePerShare: 0.5 }], () => []);
    const store = new CorporateActionsStore(provider, 'eodhd');
    await store.syncOne('AAPL_US_EQ', ms('2025-06-01'));
    const callsBefore = provider.divCalls.length;
    const byTicker = await store.dividendsForMany(['AAPL_US_EQ', 'UNKNOWN_US_EQ']);
    expect(byTicker['AAPL_US_EQ']?.map((d) => d.date)).toEqual(['2025-05-01']);
    expect(byTicker['UNKNOWN_US_EQ']).toBeUndefined();
    expect(provider.divCalls.length).toBe(callsBefore);    // read did not fetch
  });
});

// ── Provider: pence-at-the-boundary scaling + `from` cursor → next-day ───────────────────────────
// A stub EodhdClient capturing the args the real dividends()/splits() would receive, so we can
// assert the LSE pence ÷100 scaling and the strictly-after-cursor `from` translation in isolation.
class StubEodhdClient extends EodhdClient {
  divArgs: Array<{ symbol: string; from?: string }> = [];
  constructor(private readonly divRows: EodhdDividendEvent[], private readonly splitRows: EodhdSplitEvent[] = []) {
    super({ apiKey: 'k' });
  }
  override async dividends(symbol: string, from?: string): Promise<EodhdDividendEvent[]> {
    this.divArgs.push({ symbol, ...(from ? { from } : {}) });
    return this.divRows;
  }
  override async splits(): Promise<EodhdSplitEvent[]> { return this.splitRows; }
}

describe('EodhdCorporateActionsProvider', () => {
  afterEach(() => { _setEodhdClientForTest(null); });

  it('kills pence at the boundary for LSE dividends (÷100 → GBP), like prices', async () => {
    const stub = new StubEodhdClient([{ date: '2025-05-01', value: 30 }]);   // 30 pence
    _setEodhdClientForTest(stub);
    const out = await new EodhdCorporateActionsProvider().fetchDividends('HSBAl_EQ');
    expect(stub.divArgs[0]!.symbol).toBe('HSBA.LSE');
    expect(out[0]!.valuePerShare).toBeCloseTo(0.30, 10);                      // 30p → £0.30
  });

  it('leaves US dividends in dollars (scale 1)', async () => {
    const stub = new StubEodhdClient([{ date: '2025-05-01', value: 0.25 }]);
    _setEodhdClientForTest(stub);
    const out = await new EodhdCorporateActionsProvider().fetchDividends('AAPL_US_EQ');
    expect(stub.divArgs[0]!.symbol).toBe('AAPL.US');
    expect(out[0]!.valuePerShare).toBeCloseTo(0.25, 10);
  });

  it('translates a `from` cursor to the next day (events strictly after the last stored date)', async () => {
    const stub = new StubEodhdClient([]);
    _setEodhdClientForTest(stub);
    await new EodhdCorporateActionsProvider().fetchDividends('AAPL_US_EQ', '2025-05-01');
    expect(stub.divArgs[0]!.from).toBe('2025-05-02');
  });
});
