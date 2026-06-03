// Fundamentals composition root — selects the provider by FUNDAMENTALS_PROVIDER and wraps it in
// the read-through cache. Yahoo (free quoteSummary) is the default; 'eodhd' is dormant until the
// paid add-on is enabled.

import { FundamentalsCache } from './application/FundamentalsCache.ts';
import { YahooFundamentalsProvider } from './infrastructure/YahooFundamentalsProvider.ts';
import { EodhdFundamentalsProvider } from './infrastructure/EodhdFundamentalsProvider.ts';
import type { FundamentalsProvider, FxToGBP } from './infrastructure/FundamentalsProvider.ts';

export function buildFundamentalsCache(fxToGBP: FxToGBP, providerName: 'yahoo' | 'eodhd'): FundamentalsCache {
  const provider: FundamentalsProvider = providerName === 'eodhd'
    ? new EodhdFundamentalsProvider()
    : new YahooFundamentalsProvider(fxToGBP);
  return new FundamentalsCache(provider, providerName);
}
