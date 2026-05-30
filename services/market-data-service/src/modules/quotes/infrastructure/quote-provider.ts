// QuoteProvider — segregated from MarketDataProvider (Interface Segregation): bid/ask quotes
// are a separate capability the active OHLCV provider (TwelveData) does NOT supply on the free
// tier, so we do NOT force it onto MarketDataProvider. Quotes stay on Yahoo's free v7/quote
// endpoint, exactly like FX and sector classification. `buildQuoteProvider()` (index.ts) hands
// consumers a Yahoo-backed QuoteProvider regardless of which OHLCV provider is active.

export interface RawQuote {
  ticker: string;          // T212 ticker
  bid: number | null;      // null when Yahoo returns no/zero book (off-hours, thin LSE names)
  ask: number | null;
  mid: number | null;      // regularMarketPrice
  bidSize: number | null;
  askSize: number | null;
  marketState: string;     // 'REGULAR' | 'PRE' | 'POST' | 'CLOSED'
  observedAt: number;      // UTC ms
}

export interface QuoteProvider {
  readonly name: string;
  /** Batched bid/ask fetch for the active universe. Missing/closed names come back with
   *  null bid/ask so the caller can fall back to a synthetic estimate. */
  fetchQuotes(tickers: string[]): Promise<RawQuote[]>;
}
