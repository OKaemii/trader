// NewsStore — the typed read-through store for per-symbol EODHD news, with an INCREMENTAL,
// credit-thrifty sync (plan §H/§I). One Mongo doc per ticker holds the accreted article list plus a
// `lastFetchedDate` cursor (the max stored publish-date). A sync pass fetches only articles on/after
// that cursor, appends the genuinely-new ones (deduped by `link` — a link already held is skipped),
// and advances the cursor. A re-sync of a ticker with no new articles makes ZERO upstream EODHD calls
// — the store decides per ticker whether a fetch is even warranted (the daily TTL gate below), so a
// current universe spends ~no credits. EODHD-budget exhaustion in the client degrades to an empty
// fetch (never throws), so the store simply appends nothing and the panel keeps its prior articles.
//
// Reads never fetch: `peek` (admin endpoint) serves whatever the background sync has accreted. The
// store is fetched LAZILY (on symbol open via the admin endpoint's sync, or the once-daily refresher)
// — NEVER per page-load.
//
// Cursor note: news is deduped by `link`, not date — multiple articles can share a publish day. The
// `lastFetchedDate` cursor is therefore asked INCLUSIVELY (`from = lastFetchedDate`): a same-day
// article published after the last sync isn't skipped, and the link-dedupe keeps the re-append
// idempotent for articles already held.

import { getMongoDb, COLLECTIONS } from '@trader/shared-mongo';
import type { Collection } from 'mongodb';
import type { NewsProvider, ProviderNewsArticle } from '../infrastructure/NewsProvider.ts';

// A symbol re-checked for fresh news no more often than this much wall-clock since its last sync.
// News is fetched lazily (on symbol open / once-daily), so a daily re-check is the freshness floor;
// a symbol NEVER synced (no doc / no asOf) is always fetched, regardless of this gate.
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

// Cap the stored article list per symbol so a long-tracked name can't grow unbounded. The Overview
// panel + narrative context only need the most recent items; older ones drop off oldest-first.
const MAX_STORED_ARTICLES = 200;

export interface StoredNewsArticle {
  date: string;        // ISO-8601 publish timestamp
  title: string;
  link: string;        // canonical URL — the dedupe key
  symbols: string[];
  tags: string[];
  sentiment?: { polarity: number; neg: number; neu: number; pos: number };
}

export interface NewsDoc {
  _id: string;             // ticker
  articles: StoredNewsArticle[];
  lastFetchedDate?: string; // 'YYYY-MM-DD' max stored publish-date — the incremental `from` cursor
  source: string;
  asOf: number;            // last sync attempt (UTC ms) — gates the incremental TTL
  updatedAt: number;
}

// 'YYYY-MM-DD' slice of an ISO-8601 publish timestamp (the date portion is the incremental cursor).
function isoDateOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

// Max 'YYYY-MM-DD' across the articles (string compare is date-correct for fixed-width ISO dates).
function maxPublishDate(articles: StoredNewsArticle[]): string | undefined {
  let max: string | undefined;
  for (const a of articles) {
    const d = isoDateOf(a.date);
    if (d && (max === undefined || d > max)) max = d;
  }
  return max;
}

export class NewsStore {
  constructor(
    private readonly provider: NewsProvider,
    private readonly source: string,
    private readonly ttlMs = SYNC_TTL_MS,
  ) {}

  private async coll(): Promise<Collection<NewsDoc>> {
    return (await getMongoDb()).collection<NewsDoc>(COLLECTIONS.NEWS);
  }

  /** The stored doc for `ticker` (no fetch), or null. Backs the admin read. */
  async peek(ticker: string): Promise<NewsDoc | null> {
    return (await this.coll()).findOne({ _id: ticker });
  }

  /** Stored articles for `ticker` (no fetch), newest-first — the Overview Recent Events list. */
  async articlesFor(ticker: string): Promise<StoredNewsArticle[]> {
    const doc = await this.peek(ticker);
    if (!doc) return [];
    return [...doc.articles].sort((a, b) => b.date.localeCompare(a.date));
  }

  async coverage(): Promise<{ count: number; withArticles: number }> {
    const coll = await this.coll();
    const [count, withArticles] = await Promise.all([
      coll.countDocuments({}),
      coll.countDocuments({ 'articles.0': { $exists: true } }),
    ]);
    return { count, withArticles };
  }

  /**
   * Incrementally sync one ticker. Returns counts so the scheduler can pace and tests can assert the
   * no-op. A ticker synced within `ttlMs` and already holding a cursor is skipped WITHOUT a fetch
   * (`fetched: false`) — this is the §I "zero upstream calls when current" guarantee. Otherwise it
   * fetches articles from the stored publish-date cursor (default recent window when no cursor yet),
   * appends only genuinely-new links, advances the cursor, and trims to MAX_STORED_ARTICLES.
   *
   * The provider degrades to [] on EODHD-budget exhaustion / error (never throws), so this still
   * succeeds with `newArticles: 0` — the prior articles + cursor are preserved.
   */
  async syncOne(ticker: string, now = Date.now()): Promise<{ fetched: boolean; newArticles: number }> {
    const coll = await this.coll();
    const existing = await coll.findOne({ _id: ticker });

    // Gate: a ticker synced recently AND already cursored has nothing worth a credit. A never-synced
    // ticker (no doc, or a doc with no asOf) always fetches its recent window once.
    if (existing && existing.asOf != null && now - existing.asOf < this.ttlMs) {
      return { fetched: false, newArticles: 0 };
    }

    // Cursor is INCLUSIVE (see header note): same-day articles after the last sync aren't missed; the
    // link-dedupe below keeps the re-append idempotent for ones already stored.
    const fetched = await this.provider.fetchNews(ticker, {
      ...(existing?.lastFetchedDate ? { fromIso: existing.lastFetchedDate } : {}),
    });

    const haveLinks = new Set((existing?.articles ?? []).map((a) => a.link));
    const newArticles = dedupeNewArticles(fetched, haveLinks);

    // Merge, sort newest-first, trim oldest off the tail — the panel only needs the most recent.
    const merged = [...(existing?.articles ?? []), ...newArticles]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_STORED_ARTICLES);

    const set: Partial<NewsDoc> = {
      articles: merged,
      source: this.source,
      asOf: now,
      updatedAt: now,
    };
    const lastFetchedDate = maxPublishDate(merged);
    if (lastFetchedDate !== undefined) set.lastFetchedDate = lastFetchedDate;

    await coll.updateOne({ _id: ticker }, { $set: set }, { upsert: true });
    return { fetched: true, newArticles: newArticles.length };
  }

  /** Sync a batch, returning aggregate counts (and how many tickers actually hit upstream). */
  async syncMany(tickers: string[], now = Date.now()): Promise<{ tickers: number; fetched: number; newArticles: number }> {
    let fetched = 0, newArticles = 0;
    for (const t of tickers) {
      const r = await this.syncOne(t, now);
      if (r.fetched) fetched++;
      newArticles += r.newArticles;
    }
    return { tickers: tickers.length, fetched, newArticles };
  }
}

// Keep only fetched articles whose `link` the store doesn't already hold (idempotent re-append). A
// missing link or title is dropped (the client already filters empty title/date, but guard anyway).
function dedupeNewArticles(fetched: ProviderNewsArticle[], have: Set<string>): StoredNewsArticle[] {
  const out: StoredNewsArticle[] = [];
  for (const a of fetched) {
    if (!a.link || !a.title || !a.date || have.has(a.link)) continue;
    have.add(a.link);   // guard against a feed returning the same link twice in one page
    out.push({
      date: a.date,
      title: a.title,
      link: a.link,
      symbols: a.symbols ?? [],
      tags: a.tags ?? [],
      ...(a.sentiment ? { sentiment: a.sentiment } : {}),
    });
  }
  return out;
}
