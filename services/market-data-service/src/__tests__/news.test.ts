// News module: the store's INCREMENTAL sync — most importantly the §I guarantee that a re-sync of a
// current symbol makes ZERO upstream EODHD calls — plus degrade-to-empty on budget exhaustion (the
// EODHD client returns [] when the credit limiter is exhausted, so a sync appends nothing and never
// throws). The store reaches getMongoDb() internally, so we mock shared-mongo with an in-memory
// collection (the only surface the store touches) before importing the store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── In-memory Mongo (only the surface NewsStore uses) ───────────────────────────────────────────
interface AnyDoc { _id: string; [k: string]: unknown }
class FakeCollection {
  rows = new Map<string, AnyDoc>();
  async findOne(filter: { _id: string }): Promise<AnyDoc | null> {
    return this.rows.get(filter._id) ?? null;
  }
  async countDocuments(filter: Record<string, unknown>): Promise<number> {
    if (Object.keys(filter).length === 0) return this.rows.size;
    const key = Object.keys(filter)[0]!;          // 'articles.0'
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
  COLLECTIONS: { NEWS: 'news' },
  getMongoDb: async () => ({ collection: () => fakeColl }),
}));

const { NewsStore } = await import('../modules/news/application/NewsStore.ts');
import type { NewsProvider, ProviderNewsArticle } from '../modules/news/infrastructure/NewsProvider.ts';
import { EodhdNewsProvider } from '../modules/news/infrastructure/NewsProvider.ts';
import { EodhdClient, _setEodhdClientForTest, type EodhdNewsArticle } from '../modules/bars/infrastructure/providers/eodhd-client.ts';

const MS_DAY = 24 * 60 * 60 * 1000;
const ms = (iso: string) => Date.parse(iso);

const article = (
  date: string,
  link: string,
  title = `headline ${link}`,
): ProviderNewsArticle => ({ date, title, link, symbols: [], tags: [] });

// A provider that records every call (so we can assert zero calls) and returns scripted articles.
class FakeProvider implements NewsProvider {
  calls: Array<{ ticker: string; fromIso?: string }> = [];
  constructor(private readonly articles: (ticker: string, fromIso?: string) => ProviderNewsArticle[] = () => []) {}
  async fetchNews(ticker: string, opts: { fromIso?: string; limit?: number } = {}): Promise<ProviderNewsArticle[]> {
    this.calls.push({ ticker, ...(opts.fromIso ? { fromIso: opts.fromIso } : {}) });
    return this.articles(ticker, opts.fromIso);
  }
}

beforeEach(() => { fakeColl.rows.clear(); });

// ── Store: incremental sync ─────────────────────────────────────────────────────────────────────
describe('NewsStore incremental sync', () => {
  it('first sync of a fresh symbol fetches the recent window (no `from` cursor) and stores it', async () => {
    const provider = new FakeProvider(() => [
      article('2025-06-02T09:00:00Z', 'https://x/a'),
      article('2025-06-01T09:00:00Z', 'https://x/b'),
    ]);
    const store = new NewsStore(provider, 'eodhd');
    const r = await store.syncOne('AAPL_US_EQ', ms('2025-06-03T00:00:00Z'));

    expect(r).toEqual({ fetched: true, newArticles: 2 });
    expect(provider.calls).toEqual([{ ticker: 'AAPL_US_EQ' }]);   // no `fromIso` on first fetch
    const doc = await store.peek('AAPL_US_EQ');
    // stored newest-first
    expect(doc?.articles.map((a) => a.link)).toEqual(['https://x/a', 'https://x/b']);
    expect(doc?.lastFetchedDate).toBe('2025-06-02');   // max publish-date
  });

  it('THE no-op: a re-sync within the TTL makes ZERO upstream calls', async () => {
    const provider = new FakeProvider(() => [article('2025-06-01T09:00:00Z', 'https://x/a')]);
    const store = new NewsStore(provider, 'eodhd');
    const t0 = ms('2025-06-03T00:00:00Z');
    await store.syncOne('AAPL_US_EQ', t0);             // first sync populates + cursors
    const callsAfterFirst = provider.calls.length;

    // Re-sync a few hours later (within the 24h TTL): the gate must short-circuit BEFORE any fetch.
    const r = await store.syncOne('AAPL_US_EQ', t0 + 3 * 60 * 60 * 1000);
    expect(r).toEqual({ fetched: false, newArticles: 0 });
    expect(provider.calls.length).toBe(callsAfterFirst);   // no new calls
  });

  it('a re-sync past the TTL fetches from the stored publish-date cursor (inclusive) and appends new links', async () => {
    let feed: ProviderNewsArticle[] = [article('2025-06-01T09:00:00Z', 'https://x/a')];
    const provider = new FakeProvider(() => feed);
    const store = new NewsStore(provider, 'eodhd');
    const t0 = ms('2025-06-03T00:00:00Z');
    await store.syncOne('AAPL_US_EQ', t0);

    // A new article lands; re-sync a day+ later. The store passes its publish-date cursor as `fromIso`.
    feed = [article('2025-06-05T09:00:00Z', 'https://x/c')];
    const r = await store.syncOne('AAPL_US_EQ', t0 + MS_DAY + 1000);

    expect(r).toEqual({ fetched: true, newArticles: 1 });
    expect(provider.calls.at(-1)!.fromIso).toBe('2025-06-01');   // cursor = last stored publish-date (inclusive)
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.articles.map((a) => a.link)).toEqual(['https://x/c', 'https://x/a']);   // newest-first
    expect(doc?.lastFetchedDate).toBe('2025-06-05');
  });

  it('dedupes by link — a same-day cursor re-fetch returning an already-stored link appends nothing', async () => {
    // Cursor day is asked inclusively, so the feed may return the boundary article again; the
    // link-dedupe must keep this idempotent (the §I idempotency guarantee for news).
    const provider = new FakeProvider(() => [
      article('2025-06-01T09:00:00Z', 'https://x/a'),   // already stored on first sync
      article('2025-06-01T18:00:00Z', 'https://x/a2'),  // genuinely new, same day
    ]);
    const store = new NewsStore(provider, 'eodhd', /* ttlMs */ 0);   // TTL 0 → always fetch
    const t0 = ms('2025-06-03T00:00:00Z');
    await store.syncOne('AAPL_US_EQ', t0);              // stores a + a2
    const r = await store.syncOne('AAPL_US_EQ', t0 + 1000);   // same two links come back
    expect(r.newArticles).toBe(0);
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.articles).toHaveLength(2);
  });

  it('articlesFor returns stored articles newest-first without fetching', async () => {
    const provider = new FakeProvider(() => [
      article('2025-06-01T09:00:00Z', 'https://x/old'),
      article('2025-06-09T09:00:00Z', 'https://x/new'),
    ]);
    const store = new NewsStore(provider, 'eodhd');
    await store.syncOne('AAPL_US_EQ', ms('2025-06-10T00:00:00Z'));
    const callsBefore = provider.calls.length;
    const articles = await store.articlesFor('AAPL_US_EQ');
    expect(articles.map((a) => a.link)).toEqual(['https://x/new', 'https://x/old']);
    expect(provider.calls.length).toBe(callsBefore);   // read did not fetch
  });

  it('syncMany reports how many symbols actually hit upstream (current ones cost nothing)', async () => {
    const provider = new FakeProvider(() => [article('2025-06-01T09:00:00Z', 'https://x/a')]);
    const store = new NewsStore(provider, 'eodhd');
    const t0 = ms('2025-06-03T00:00:00Z');
    await store.syncOne('AAPL_US_EQ', t0);             // AAPL now current
    const before = provider.calls.length;
    const agg = await store.syncMany(['AAPL_US_EQ', 'MSFT_US_EQ'], t0 + 60_000);
    // AAPL skipped (within TTL), MSFT fetched once.
    expect(agg.fetched).toBe(1);
    expect(provider.calls.length).toBe(before + 1);
  });
});

// ── Store: degrade-to-empty on budget exhaustion ────────────────────────────────────────────────
describe('NewsStore degrades to empty on EODHD budget exhaustion', () => {
  it('an empty fetch (exhausted budget) appends nothing and never throws, preserving prior articles', async () => {
    // Seed a symbol, then have the next fetch return [] (the client's exhaustion behaviour).
    let feed: ProviderNewsArticle[] = [article('2025-06-01T09:00:00Z', 'https://x/a')];
    const provider = new FakeProvider(() => feed);
    const store = new NewsStore(provider, 'eodhd', /* ttlMs */ 0);   // always fetch
    const t0 = ms('2025-06-03T00:00:00Z');
    await store.syncOne('AAPL_US_EQ', t0);

    feed = [];   // budget exhausted → client returns []
    const r = await store.syncOne('AAPL_US_EQ', t0 + 1000);
    expect(r).toEqual({ fetched: true, newArticles: 0 });
    const doc = await store.peek('AAPL_US_EQ');
    expect(doc?.articles.map((a) => a.link)).toEqual(['https://x/a']);   // prior article preserved
    expect(doc?.lastFetchedDate).toBe('2025-06-01');                     // cursor unchanged
  });

  it('a fresh symbol with an exhausted budget stores an empty list and never throws', async () => {
    const provider = new FakeProvider(() => []);   // exhausted from the first call
    const store = new NewsStore(provider, 'eodhd');
    const r = await store.syncOne('NVDA_US_EQ', ms('2025-06-03T00:00:00Z'));
    expect(r).toEqual({ fetched: true, newArticles: 0 });
    const doc = await store.peek('NVDA_US_EQ');
    expect(doc?.articles).toEqual([]);
    expect(doc?.lastFetchedDate).toBeUndefined();   // nothing stored → no cursor
  });
});

// ── Provider: EODHD symbol resolution + sentiment pass-through / degrade ─────────────────────────
// A stub EodhdClient capturing the args the real news() would receive, so we can assert the
// T212→EODHD symbol resolution, the `from` pass-through, and the degrade-to-[] path in isolation.
class StubEodhdClient extends EodhdClient {
  newsArgs: Array<{ symbol: string; opts: { from?: string; limit?: number } }> = [];
  constructor(private readonly rows: EodhdNewsArticle[]) { super({ apiKey: 'k' }); }
  override async news(symbol: string, opts: { limit?: number; offset?: number; from?: string; to?: string } = {}): Promise<EodhdNewsArticle[]> {
    this.newsArgs.push({ symbol, opts: { ...(opts.from ? { from: opts.from } : {}), ...(opts.limit != null ? { limit: opts.limit } : {}) } });
    return this.rows;
  }
}

describe('EodhdNewsProvider', () => {
  afterEach(() => { _setEodhdClientForTest(null); });

  it('resolves the T212 ticker to its EODHD symbol and passes `from` through', async () => {
    const stub = new StubEodhdClient([
      { date: '2025-06-01T09:00:00Z', title: 't', link: 'https://x/a', symbols: ['AAPL.US'], tags: ['earnings'] },
    ]);
    _setEodhdClientForTest(stub);
    const out = await new EodhdNewsProvider().fetchNews('AAPL_US_EQ', { fromIso: '2025-06-01' });
    expect(stub.newsArgs[0]!.symbol).toBe('AAPL.US');
    expect(stub.newsArgs[0]!.opts.from).toBe('2025-06-01');
    expect(out[0]!.link).toBe('https://x/a');
    expect(out[0]!.tags).toEqual(['earnings']);
  });

  it('resolves an LSE ticker to its .LSE symbol', async () => {
    const stub = new StubEodhdClient([]);
    _setEodhdClientForTest(stub);
    await new EodhdNewsProvider().fetchNews('HSBAl_EQ');
    expect(stub.newsArgs[0]!.symbol).toBe('HSBA.LSE');
    expect(stub.newsArgs[0]!.opts.from).toBeUndefined();   // no cursor → no `from`
  });

  it('passes sentiment through when the tier returns it (optional enrichment)', async () => {
    const stub = new StubEodhdClient([
      { date: '2025-06-01T09:00:00Z', title: 't', link: 'https://x/a', symbols: [], tags: [], sentiment: { polarity: 0.4, neg: 0.1, neu: 0.5, pos: 0.4 } },
    ]);
    _setEodhdClientForTest(stub);
    const out = await new EodhdNewsProvider().fetchNews('AAPL_US_EQ');
    expect(out[0]!.sentiment).toEqual({ polarity: 0.4, neg: 0.1, neu: 0.5, pos: 0.4 });
  });

  it('returns [] when the client degrades (exhausted budget) — never throws', async () => {
    const stub = new StubEodhdClient([]);
    _setEodhdClientForTest(stub);
    await expect(new EodhdNewsProvider().fetchNews('AAPL_US_EQ')).resolves.toEqual([]);
  });
});
