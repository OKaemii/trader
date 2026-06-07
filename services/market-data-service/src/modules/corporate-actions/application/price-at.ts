// Pure "price at/<= asOf" lookup over a daily bar series — the dividend-yield denominator. The
// series is the persisted bi-temporal daily bars (already pence-killed → BASE units, matching the
// dividend values). We pick the latest bar whose observation_ts is <= asOf; for a live cycle asOf is
// ≈now so that is the most recent close, and for a backfill replay it is the point-in-time close,
// never a future one (no look-ahead).
//
// WHY rawClose, not close: the persisted daily `close` is the total-return ADJUSTED close (split +
// dividend adjusted, so historical returns include reinvested dividends) — it is depressed below the
// price actually traded that day by the cumulative dividend/split factor. A dividend YIELD must
// divide the RAW (as-paid) trailing dividend-per-share by the RAW (as-traded) price on that date, or
// the adjusted denominator inflates the yield. The daily writer stores the unadjusted price as
// `rawClose` alongside `close` (eodRowToDailyBar), so we prefer it; legacy rows / the 5m-aggregation
// fallback carry no rawClose, so we fall back to `close` (best available, accepting the slight bias
// on those rows rather than dropping the name).

import type { OHLCVBar } from '@trader/shared-types';

/** The unadjusted price of a bar — rawClose when the daily writer stored it, else the close. */
function unadjustedPrice(b: OHLCVBar): number {
  return Number.isFinite(b.rawClose) && (b.rawClose as number) > 0 ? (b.rawClose as number) : b.close;
}

/**
 * Latest unadjusted price (BASE units) of a bar with `observation_ts <= asOfMs`, or null when none
 * qualifies (empty/all-future series → no honest denominator → the yield is omitted, not fabricated).
 * Bars need not be pre-sorted. Non-finite / non-positive prices are skipped.
 */
export function closeAtOrBefore(bars: OHLCVBar[], asOfMs: number): number | null {
  let bestTs = -Infinity;
  let bestPrice: number | null = null;
  for (const b of bars) {
    const ts = b.observation_ts ?? b.timestamp;
    if (ts == null || ts > asOfMs) continue;
    const price = unadjustedPrice(b);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (ts > bestTs) { bestTs = ts; bestPrice = price; }
  }
  return bestPrice;
}
