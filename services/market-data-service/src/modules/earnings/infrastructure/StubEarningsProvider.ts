// Earnings/dividend-date provider — STUBBED placeholder (epic pit-fundamentals-lake-rearchitecture,
// Thread C / decision I). The Yahoo `calendarEvents` source was dropped platform-wide and no
// PIT-backed earnings-date source is wired yet, so this provider has no dates for any ticker and
// returns an empty map. A provider OMITS a ticker when it has no date (the existing contract), so an
// empty result means the store accretes nothing and the overlap-detector reports `within:false` for
// every holding — a clean no-op, never a false "no earnings soon". The interface is preserved so a
// later epic can re-wire earnings dates from PIT data without touching the store/scheduler/routes.

import type { EarningsProvider, EarningsInfo } from './EarningsProvider.ts';

export class StubEarningsProvider implements EarningsProvider {
  /** No earnings/dividend dates are available yet — every ticker is omitted. */
  async fetch(_tickers: string[]): Promise<Record<string, EarningsInfo>> {
    return {};
  }
}
