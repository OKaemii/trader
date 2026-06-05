// EodhdQuoteProvider — real-time (delayed) last-trade prices from EODHD, mapped to RawQuote.
// EODHD real-time has NO bid/ask book, so bid/ask are null and only `mid` (the last trade) is set;
// the quote-poll builds a real (non-synthetic) mid-only row from it. This freshens the drift gate /
// TCA mid but does NOT feed the §29b spread filter (which needs a real spread).
//
// Requires the EODHD real-time add-on; on a plan without it the endpoint 4xxs, realTimeQuotes()
// returns [], and quote-poll degrades to the synthetic proxy. Pence (LSE) is killed at this
// boundary — divide by 100 — exactly like the EOD/bars path, so the mid is GBP downstream.

import type { QuoteProvider, RawQuote } from './quote-provider.ts';
import { getEodhdClient, toEodhdSymbol } from '../../bars/infrastructure/providers/eodhd-client.ts';

type EodhdClientLike = Pick<ReturnType<typeof getEodhdClient>, 'realTimeQuotes'>;

export class EodhdQuoteProvider implements QuoteProvider {
  readonly name = 'eodhd';

  constructor(private readonly client: EodhdClientLike = getEodhdClient()) {}

  async fetchQuotes(tickers: string[]): Promise<RawQuote[]> {
    // Map T212 → EODHD symbol, keeping the reverse so results map back to the T212 ticker.
    const t212ByEodhd = new Map<string, string>();
    for (const t of tickers) t212ByEodhd.set(toEodhdSymbol(t), t);

    const rows = await this.client.realTimeQuotes([...t212ByEodhd.keys()]);
    const out: RawQuote[] = [];
    for (const r of rows) {
      const ticker = t212ByEodhd.get(r.code);
      if (!ticker) continue;
      // LSE quotes in pence (GBX) → GBP, same boundary policy as the EOD/bars path.
      const scale = r.code.endsWith('.LSE') ? 0.01 : 1;
      out.push({
        ticker,
        bid: null,
        ask: null,
        mid: r.close * scale,
        bidSize: null,
        askSize: null,
        marketState: 'REGULAR',
        observedAt: r.timestampMs,
      });
    }
    return out;
  }
}
