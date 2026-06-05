// TwelveDataFxProvider — GBP-per-1-USD from TwelveData's /exchange_rate endpoint. We request the
// USD/GBP pair so the returned `rate` IS already GBP-per-USD (~0.79) — no inversion, unlike Yahoo's
// GBPUSD=X. TwelveData's free Basic plan includes /exchange_rate (1 credit); only market-data-service
// calls this, once per refresh interval, so the cost is negligible. Single-direction contract,
// matching FxRateProvider.

import type { FxRateProvider } from './FxClient.ts';

interface TdExchangeRateResponse {
  rate?: number;
  // TwelveData returns errors as HTTP 200 with a status/code/message instead of a rate.
  status?: string;
  code?: number;
  message?: string;
}

export class TwelveDataFxProvider implements FxRateProvider {
  private static readonly BASE = 'https://api.twelvedata.com/exchange_rate';

  constructor(private readonly apiKey: string | undefined) {}

  async fetchUsdGbpRate(): Promise<number> {
    if (!this.apiKey) throw new Error('TwelveData FX: TWELVEDATA_API_KEY unset');
    const url = `${TwelveDataFxProvider.BASE}?symbol=USD/GBP&apikey=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`TwelveData exchange_rate HTTP ${res.status}`);
    const body = (await res.json()) as TdExchangeRateResponse;
    if (typeof body.rate !== 'number' || !(body.rate > 0)) {
      throw new Error(`TwelveData exchange_rate USD/GBP: ${body.message ?? 'no rate in response'}`);
    }
    return body.rate; // GBP per 1 USD
  }
}
