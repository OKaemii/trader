// Yahoo-backed QuoteProvider — free v7/finance/quote endpoint (bid/ask). Separate from the
// bars provider (ISP): quotes are their own capability and stay on Yahoo regardless of the
// active OHLCV provider, like FX/sector. Symbol mapping reuses the bars provider's
// toYahooSymbol so US/LSE suffix handling stays in one place.
import { log } from '../../../logger.ts';
import { toYahooSymbol } from '../../bars/infrastructure/providers/yahoo-client.ts';
import type { QuoteProvider, RawQuote } from './quote-provider.ts';

const QUOTE_BATCH_SIZE = 50;      // Yahoo's documented symbols-per-request cap
const QUOTE_BATCH_DELAY_MS = 500;

interface YahooQuoteResult {
  symbol?: string;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  marketState?: string;
}

export class YahooQuoteProvider implements QuoteProvider {
  readonly name = 'yahoo';

  async fetchQuotes(tickers: string[]): Promise<RawQuote[]> {
    // T212 → Yahoo symbol, keeping a reverse map so results map back to the T212 ticker.
    const symbolToTicker = new Map<string, string>();
    const symbols = tickers.map((t) => {
      const s = toYahooSymbol(t);
      symbolToTicker.set(s, t);
      return s;
    });

    const out: RawQuote[] = [];
    for (let i = 0; i < symbols.length; i += QUOTE_BATCH_SIZE) {
      const batch = symbols.slice(i, i + QUOTE_BATCH_SIZE);
      try {
        const results = await this.fetchBatch(batch);
        for (const r of results) {
          const ticker = r.symbol ? symbolToTicker.get(r.symbol) : undefined;
          if (!ticker) continue;
          const bid = typeof r.bid === 'number' && r.bid > 0 ? r.bid : null;
          const ask = typeof r.ask === 'number' && r.ask > 0 ? r.ask : null;
          out.push({
            ticker,
            bid,
            ask,
            mid: typeof r.regularMarketPrice === 'number' ? r.regularMarketPrice : null,
            bidSize: r.bidSize ?? null,
            askSize: r.askSize ?? null,
            marketState: r.marketState ?? 'CLOSED',
            observedAt: (r.regularMarketTime ?? Math.floor(Date.now() / 1000)) * 1000,
          });
        }
      } catch (err) {
        log.warn('[yahoo-quote] batch failed:', err);
      }
      if (i + QUOTE_BATCH_SIZE < symbols.length) {
        await new Promise((res) => setTimeout(res, QUOTE_BATCH_DELAY_MS));
      }
    }
    return out;
  }

  private async fetchBatch(symbols: string[]): Promise<YahooQuoteResult[]> {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Yahoo quote HTTP ${res.status}`);
    const data = (await res.json()) as { quoteResponse?: { result?: YahooQuoteResult[] } };
    return data.quoteResponse?.result ?? [];
  }
}

export function buildQuoteProvider(): QuoteProvider {
  // Always Yahoo — the free quote side-channel. When a paid real-time feed is added,
  // branch here on an env var, same as buildProvider() does for OHLCV.
  return new YahooQuoteProvider();
}
