// Corporate-actions composition root. EODHD is the only source (Dividends/Splits feeds, Task 13); a
// missing EODHD key leaves the provider degrading to empty (the client's get() returns [] without a
// key path), so the store/endpoints stay up and simply hold nothing — mirroring how the daily-feed
// path no-ops without EODHD.

import { CorporateActionsStore, type OnNewActions } from './application/CorporateActionsStore.ts';
import { EodhdCorporateActionsProvider } from './infrastructure/CorporateActionsProvider.ts';

// `onNewActions` (optional): the new-event hook — the corporate-actions watcher binds it to a forced
// daily-series re-adjust (plan §8 Gap 1). Absent ⇒ the store accretes events but triggers nothing.
export function buildCorporateActionsStore(
  opts: { syncTtlMs?: number; onNewActions?: OnNewActions } = {},
): CorporateActionsStore {
  return new CorporateActionsStore(new EodhdCorporateActionsProvider(), 'eodhd', opts.syncTtlMs, opts.onNewActions);
}
