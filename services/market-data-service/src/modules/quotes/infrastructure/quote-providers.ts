// Quote provider composition root. Real bid/ask quotes are NOT on the free tier of any active
// provider (TwelveData's credit budget is spent on the daily bar poll; Yahoo's v7/quote endpoint
// was removed because its per-IP rate-limiting starved the fundamentals quoteSummary handshake on
// the same IP). So `buildQuoteProvider` returns a NullQuoteProvider: the QuotePoll loop then writes
// its synthetic high-low proxy for every ticker (from the latest stored bar). Consumers degrade
// gracefully — the drift gate / TCA fall back to last-close, and the universe real-spread filter
// (is_synthetic=FALSE) goes pass-through until a real feed exists.
//
// Phase 2 (real quotes on a paid feed) plugs the paid provider in here, branching on an env var
// exactly as buildProvider() does for OHLCV — e.g. an EodhdQuoteProvider behind the credit limiter
// (NOT TwelveData, whose free budget must stay reserved for the live bar poll).

import type { QuoteProvider, RawQuote } from './quote-provider.ts';

/** Returns no real quotes — every ticker falls through to QuotePoll's synthetic proxy. */
export class NullQuoteProvider implements QuoteProvider {
  readonly name = 'none';
  async fetchQuotes(_tickers: string[]): Promise<RawQuote[]> { return []; }
}

export function buildQuoteProvider(): QuoteProvider {
  return new NullQuoteProvider();
}
