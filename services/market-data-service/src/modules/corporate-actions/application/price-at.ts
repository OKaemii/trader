// Pure "close at/<= asOf" lookup over a daily bar series — the dividend-yield denominator. The
// series is the persisted bi-temporal daily bars (already pence-killed → BASE units, matching the
// dividend values). We pick the latest bar whose observation_ts is <= asOf; for a live cycle asOf is
// ≈now so that is the most recent close, and for a backfill replay it is the point-in-time close,
// never a future one (no look-ahead).

import type { OHLCVBar } from '@trader/shared-types';

/**
 * Latest `close` (BASE units) of a bar with `observation_ts <= asOfMs`, or null when none qualifies
 * (empty/all-future series → no honest denominator → the yield is omitted, not fabricated). Bars
 * need not be pre-sorted. Non-finite / non-positive closes are skipped.
 */
export function closeAtOrBefore(bars: OHLCVBar[], asOfMs: number): number | null {
  let bestTs = -Infinity;
  let bestClose: number | null = null;
  for (const b of bars) {
    const ts = b.observation_ts ?? b.timestamp;
    if (ts == null || ts > asOfMs) continue;
    if (!Number.isFinite(b.close) || b.close <= 0) continue;
    if (ts > bestTs) { bestTs = ts; bestClose = b.close; }
  }
  return bestClose;
}
