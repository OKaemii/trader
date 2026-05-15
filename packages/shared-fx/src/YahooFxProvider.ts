// YahooFxProvider — fetches GBP-per-1-USD rate from Yahoo's free chart endpoint.
// Symbol semantics: `GBPUSD=X` quotes USD per 1 GBP (i.e. ~1.27). We invert to get
// our internal rate (GBP per 1 USD, ~0.79) so the FxClient stores a single direction.

import type { FxRateProvider } from './FxClient.ts';

interface YahooChartResponse {
  chart: {
    result: Array<{
      meta?: { regularMarketPrice?: number };
      timestamp: number[];
      indicators: { quote: Array<{ close: (number | null)[] }> };
    }> | null;
    error: unknown;
  };
}

export class YahooFxProvider implements FxRateProvider {
  // GBP/USD pair. We sample at 1d granularity over a 5d window so a single weekend
  // or holiday doesn't leave us with no quote — we take the most recent non-null close.
  private static readonly URL =
    'https://query1.finance.yahoo.com/v8/finance/chart/GBPUSD%3DX?interval=1d&range=5d';

  async fetchUsdGbpRate(): Promise<number> {
    const res = await fetch(YahooFxProvider.URL, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Yahoo GBPUSD=X HTTP ${res.status}`);
    const data = (await res.json()) as YahooChartResponse;

    const result = data.chart?.result?.[0];
    // Prefer regularMarketPrice (live), fall back to most recent non-null close.
    const usdPerGbp = (() => {
      const live = result?.meta?.regularMarketPrice;
      if (typeof live === 'number' && live > 0) return live;
      const closes = result?.indicators?.quote?.[0]?.close ?? [];
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (c != null && c > 0) return c;
      }
      return null;
    })();

    if (usdPerGbp == null) throw new Error('Yahoo GBPUSD=X: no valid close');
    // Invert: Yahoo gives USD per 1 GBP; we want GBP per 1 USD.
    return 1 / usdPerGbp;
  }
}
