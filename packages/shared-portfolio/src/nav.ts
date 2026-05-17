import type { Money, Currency } from '@trader/shared-types';

// FxConverter is the minimal interface shared-portfolio needs from @trader/shared-fx's
// FxClient. Declared structurally here so this package stays test-isolated and doesn't
// pull a redis dependency into a pure-math helper.
export interface FxConverter {
  toGBP(m: Money): Promise<number>;
}

// Subset of the persisted position shape that NAV math cares about. The full Mongo
// document carries more fields (ticker, weight, updatedAt, ...) — none load-bearing
// for sumPositionsGBP, so we keep the contract narrow.
export interface PositionDoc {
  ticker?:       string;
  quantity?:     number;
  currency?:     Currency;
  currentPrice?: Money;
  currentValue?: Money;
}

// Sum currentValue across positions in GBP. The single read-side helper that owns
// the FX call — replaces the portfolio-service dual-write of currentValueGBP.
//
// Behaviour:
//   - Skips rows with missing or non-positive currentValue (treated as 0 contribution
//     so a not-yet-synced row doesn't block the whole NAV).
//   - Throws if fx.toGBP throws (i.e. live FX failed AND lastGood is stale past 24h).
//     Callers (RiskEngine, portfolio-service sync) decide whether to halt or degrade —
//     critically, NO caller can silently substitute a native scalar for a GBP one,
//     which was the bug class this helper retires.
export async function sumPositionsGBP(
  positions: readonly PositionDoc[],
  fx: FxConverter,
): Promise<number> {
  let total = 0;
  for (const p of positions) {
    const v = p.currentValue;
    if (!v || typeof v.amount !== 'number' || v.amount <= 0 || !v.currency) continue;
    total += await fx.toGBP(v);
  }
  return total;
}
