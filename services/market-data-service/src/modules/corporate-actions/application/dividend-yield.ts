// Point-in-time, backfillable dividend-yield computation — the Value factor's div-yield leg.
//
// WHY this is the only honestly-backfillable fundamentals leg (plan §H): EODHD Fundamentals is not
// entitled, so ROE/earnings/book are forward-only (today's Yahoo snapshot). But the EODHD Dividends
// feed is point-in-time by ex-dividend date, so a *historical* dividend yield can be reconstructed
// without look-ahead: at any past knowledge-time `asOf`, the trailing-12-month dividend-per-share is
// exactly the dividends whose ex-date already passed by `asOf`, and the denominator is the close on
// (or before) `asOf`. The strategy factor host injects the result as `dividend_yield` on
// `HistoryView.fundamentals[t]` (the snake_case key `quant_core.strategy.factors.ValueFactor`
// z-scores); T9 (live factor host) and T17 (research backfill) both consume this same shape.
//
// Units invariant: the store keeps dividend `valuePerShare` already scaled to BASE units (LSE pence
// killed at the boundary, like prices — see CorporateActionsStore). The price passed here is the
// persisted daily `close`, which is in the SAME base units (the daily-history writer kills pence
// too). So the ratio is unit-consistent — a dimensionless yield — with no FX/scale fix-up needed.

const TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

// 'YYYY-MM-DD' ex-date → the UTC ms instant the market first prices the dividend in (00:00:00Z of
// the ex-date). A dividend is "known as-of" `asOf` once its ex-date instant is <= asOf.
export function exDateMs(isoDate: string): number {
  // Date.parse of a bare 'YYYY-MM-DD' is UTC midnight by spec — exactly the point-in-time instant.
  return Date.parse(isoDate);
}

export interface DividendForYield {
  date: string;          // 'YYYY-MM-DD' ex-dividend date
  valuePerShare: number; // gross dividend per share, BASE units (already pence-killed)
}

/**
 * Trailing-12-month dividend-per-share known as-of `asOfMs` (sum of dividends whose ex-date instant
 * is in `(asOfMs - 365d, asOfMs]`). Pure — no I/O. Out-of-window / future / non-finite events are
 * excluded; a name with no qualifying dividend returns 0 (NOT NaN — zero TTM dividend is a real,
 * finite signal: a non-payer; the *yield* is then a finite 0, which the factor z-scores normally).
 */
export function trailingDividendPerShare(dividends: DividendForYield[], asOfMs: number): number {
  const windowStart = asOfMs - TRAILING_WINDOW_MS;
  let sum = 0;
  for (const d of dividends) {
    if (!Number.isFinite(d.valuePerShare) || d.valuePerShare < 0) continue;
    const t = exDateMs(d.date);
    if (!Number.isFinite(t)) continue;
    if (t > asOfMs) continue;          // not yet ex as-of the knowledge-time — would be look-ahead
    if (t <= windowStart) continue;    // older than the trailing year
    sum += d.valuePerShare;
  }
  return sum;
}

/**
 * Point-in-time trailing dividend YIELD = trailing-12m dividend-per-share / price, both BASE units.
 * Returns `null` (NOT 0) when the price is missing/non-positive — an absent denominator has no
 * honest yield, so the factor host omits `dividend_yield` for that name (NaN-excluded by the factor,
 * never a fabricated 0). A finite price with zero trailing dividends yields a finite 0 (a real
 * non-payer signal). `priceBase` is the daily close at/<= asOf, in the same base units as the
 * dividend values.
 */
export function dividendYieldAsOf(
  dividends: DividendForYield[],
  priceBase: number | null | undefined,
  asOfMs: number,
): number | null {
  if (priceBase == null || !Number.isFinite(priceBase) || priceBase <= 0) return null;
  const ttm = trailingDividendPerShare(dividends, asOfMs);
  return ttm / priceBase;
}
