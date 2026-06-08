// Fundamentals composition root — selects the provider by FUNDAMENTALS_PROVIDER and wraps it in
// the read-through cache. Yahoo (free quoteSummary) is the default; 'eodhd' is dormant until the
// paid add-on is enabled; 'pit' routes US names to the SEC-EDGAR warehouse via fundamentals-api
// with the Yahoo provider injected as the non-US / PIT-miss / outage fall-back.

import { FundamentalsCache } from './application/FundamentalsCache.ts';
import { YahooFundamentalsProvider } from './infrastructure/YahooFundamentalsProvider.ts';
import { EodhdFundamentalsProvider } from './infrastructure/EodhdFundamentalsProvider.ts';
import { PitFundamentalsProvider } from './infrastructure/PitFundamentalsProvider.ts';
import type { FundamentalsProvider, FxToGBP } from './infrastructure/FundamentalsProvider.ts';

export function buildFundamentalsCache(
  fxToGBP: FxToGBP,
  providerName: 'yahoo' | 'eodhd' | 'pit',
  opts: { requestSpacingMs?: number; pitBaseUrl?: string } = {},
): FundamentalsCache {
  // Default qs (real Yahoo session); spacing widened from env to stay under Yahoo's per-IP limit.
  // Always constructed for the 'pit' branch too — it IS the injected fall-back there.
  const yahoo = new YahooFundamentalsProvider(fxToGBP, undefined, opts.requestSpacingMs);
  let provider: FundamentalsProvider;
  if (providerName === 'eodhd') {
    provider = new EodhdFundamentalsProvider();
  } else if (providerName === 'pit') {
    // FUNDAMENTALS_API_URL points at the in-cluster read side of the PIT warehouse.
    provider = new PitFundamentalsProvider(yahoo, opts.pitBaseUrl ?? '');
  } else {
    provider = yahoo;
  }
  return new FundamentalsCache(provider, providerName);
}
