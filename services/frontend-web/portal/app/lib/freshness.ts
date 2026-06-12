// Data-freshness verdict for market-data-derived figures (factor percentiles, scores, scanner caps).
//
// A datum carries an `observation_ts` (the session/cycle it is from). market-data-service's /health
// publishes `expected_latest_bar_ts` per market — the observation_ts the latest bar SHOULD have, given
// each exchange's most recent COMPLETED session (holiday-aware, from @trader/shared-calendar). A datum
// is "not live" when its observation_ts predates that: it missed the most recent session because the
// market has since closed/moved on (or the producer fell behind). This is the "older than the last
// session" rule — stricter than "is the market open right now", and correct across weekends/holidays.
//
// Pure (no timers, no DOM, no fetch) so it is unit-tested; the I/O (reading /health) lives at the
// call site (the scores proxy / a server component), which passes the expected-latest map in.

import { marketOf, type Market } from '@/components/market'

export interface ExpectedLatestByMarket {
  US?: number | null
  LSE?: number | null
}

export interface Freshness {
  /** The datum's observation_ts — "when the data being shown is from". Null when absent/non-finite. */
  asOf: number | null
  /** true = not live (older than the last session) · false = live (current session) · null = can't
   *  tell (no market for the ticker, or /health didn't publish an expected-latest for it). The UI
   *  shows the as-of time without a live/not-live claim it can't back up. */
  stale: boolean | null
  market: Market
  expectedLatest: number | null
}

/** The freshness verdict for one datum, given the per-market expected-latest-bar map from /health. */
export function computeFreshness(
  observationTs: number | null | undefined,
  ticker: string | null | undefined,
  expected: ExpectedLatestByMarket | null | undefined,
): Freshness {
  const asOf =
    typeof observationTs === 'number' && Number.isFinite(observationTs) ? observationTs : null
  const market = marketOf(ticker ?? undefined)
  const raw = market === 'US' || market === 'LSE' ? expected?.[market] : null
  const expectedLatest = typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  const stale = asOf !== null && expectedLatest !== null ? asOf < expectedLatest : null
  return { asOf, stale, market, expectedLatest }
}
