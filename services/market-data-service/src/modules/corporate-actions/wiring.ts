// Corporate-actions composition root. EODHD is the only source (Dividends/Splits feeds, Task 13); a
// missing EODHD key leaves the provider degrading to empty (the client's get() returns [] without a
// key path), so the store/endpoints stay up and simply hold nothing — mirroring how the daily-feed
// path no-ops without EODHD.

import { CorporateActionsStore } from './application/CorporateActionsStore.ts';
import { EodhdCorporateActionsProvider } from './infrastructure/CorporateActionsProvider.ts';

export function buildCorporateActionsStore(opts: { syncTtlMs?: number } = {}): CorporateActionsStore {
  return new CorporateActionsStore(new EodhdCorporateActionsProvider(), 'eodhd', opts.syncTtlMs);
}
