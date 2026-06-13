// Fundamentals composition root — selects the QMJ provider by FUNDAMENTALS_PROVIDER and wraps it in
// the read-through cache. After the Yahoo removal (epic pit-fundamentals-lake-rearchitecture, Thread
// C + decision H) the live source is the PIT SEC-EDGAR lake via fundamentals-api: US names resolve
// from the lake, non-US names FAIL-CLOSED (no fundamentals — no Yahoo substitute). `eodhd` stays a
// dormant (paid add-on) alternative; there is no longer a `yahoo` option.

import { FundamentalsCache } from './application/FundamentalsCache.ts';
import { EodhdFundamentalsProvider } from './infrastructure/EodhdFundamentalsProvider.ts';
import { PitFundamentalsProvider } from './infrastructure/PitFundamentalsProvider.ts';
import type { FundamentalsProvider } from './infrastructure/FundamentalsProvider.ts';

export function buildFundamentalsCache(
  providerName: 'eodhd' | 'pit',
  opts: { pitBaseUrl?: string } = {},
): FundamentalsCache {
  let provider: FundamentalsProvider;
  if (providerName === 'eodhd') {
    // Dormant paid add-on; returns no data until the EODHD fundamentals entitlement is enabled.
    provider = new EodhdFundamentalsProvider();
  } else {
    // 'pit' (the live path): US → the PIT lake via fundamentals-api; non-US → fail-closed (omitted).
    // FUNDAMENTALS_API_URL points at the in-cluster read side of the PIT lake.
    provider = new PitFundamentalsProvider(opts.pitBaseUrl ?? '');
  }
  return new FundamentalsCache(provider, providerName);
}
