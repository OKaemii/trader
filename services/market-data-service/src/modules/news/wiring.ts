// News composition root. EODHD is the only source (News feed, Task 13); a missing EODHD key leaves
// the provider degrading to empty (the client's get() returns [] without a key path), so the
// store/endpoints stay up and simply hold nothing — mirroring the corporate-actions/daily-feed paths.

import { NewsStore } from './application/NewsStore.ts';
import { EodhdNewsProvider } from './infrastructure/NewsProvider.ts';

export function buildNewsStore(opts: { syncTtlMs?: number } = {}): NewsStore {
  return new NewsStore(new EodhdNewsProvider(), 'eodhd', opts.syncTtlMs);
}
