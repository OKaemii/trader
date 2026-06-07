// NewsProvider — the seam the news store fetches articles through. Wraps the EODHD client's thin
// `news()` method (Task 13) plus the T212→EODHD symbol resolution, so the store stays free of
// EODHD/symbol details and the unit tests inject a fake without an HTTP round-trip. The optional
// `fromIso` ('YYYY-MM-DD') lets the store fetch only articles from its stored cursor onward (plan §I
// incremental sync); EODHD's news feed filters server-side by `from`, so a current symbol costs one
// near-empty call (and zero when the store decides it has nothing to fetch — see NewsStore).
//
// News carries no monetary value, so there is no pence-at-the-boundary scaling here (unlike the
// corporate-actions provider). Sentiment is passed through verbatim — present only when the tier
// returns it; the panel works on headlines + links alone.

import {
  getEodhdClient,
  toEodhdSymbol,
  type EodhdNewsArticle,
} from '../../bars/infrastructure/providers/eodhd-client.ts';

// One news article — the store-facing shape (a straight pass-through of EodhdNewsArticle, re-exported
// here so the store and routes import a single news-module type rather than reaching into the client).
export interface ProviderNewsArticle {
  date: string;        // ISO-8601 publish timestamp as returned by EODHD
  title: string;
  link: string;        // canonical article URL — the dedupe key (publish-date is not unique per day)
  symbols: string[];   // related EODHD symbols (may be empty)
  tags: string[];      // EODHD topic tags (may be empty)
  sentiment?: { polarity: number; neg: number; neu: number; pos: number };  // only if the tier returns it
}

export interface NewsProvider {
  /**
   * Recent news articles for `t212Ticker`. `fromIso` ('YYYY-MM-DD', omit for the default recent
   * window) narrows the EODHD `from` so the store fetches only articles on/after its cursor — the
   * store dedupes by `link`, so the cursor day is asked inclusively (a same-day article published
   * after the last sync isn't missed). `limit` caps the page (the client clamps to [1,1000]).
   */
  fetchNews(t212Ticker: string, opts?: { fromIso?: string; limit?: number }): Promise<ProviderNewsArticle[]>;
}

export class EodhdNewsProvider implements NewsProvider {
  async fetchNews(
    t212Ticker: string,
    opts: { fromIso?: string; limit?: number } = {},
  ): Promise<ProviderNewsArticle[]> {
    const eodhdSymbol = toEodhdSymbol(t212Ticker);
    const articles: EodhdNewsArticle[] = await getEodhdClient().news(eodhdSymbol, {
      ...(opts.fromIso ? { from: opts.fromIso } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    });
    // EodhdNewsArticle is already the store-facing shape (body text dropped, sentiment optional) — the
    // client filtered out empty title/date rows, so this is a structural identity pass-through.
    return articles.map((a) => ({
      date: a.date,
      title: a.title,
      link: a.link,
      symbols: a.symbols,
      tags: a.tags,
      ...(a.sentiment ? { sentiment: a.sentiment } : {}),
    }));
  }
}
