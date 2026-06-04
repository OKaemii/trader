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
  averagePrice?: Money;   // T212 cost basis per share (instrument currency); used for open P&L
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

// Open (unrealised) P&L across positions, in GBP. For each position that carries BOTH a market
// value AND a cost basis (averagePrice × quantity), adds `marketValue − costBasis`. Positions
// missing a cost basis are skipped entirely (not fabricated as 100% gain) and reported via
// `covered` so a consumer can flag partial coverage. This is the honest "how are the open
// positions doing right now" number — distinct from realised round-trip P&L, which is 0 until
// something is actually sold.
export async function sumOpenPnlGBP(
  positions: readonly PositionDoc[],
  fx: FxConverter,
): Promise<{ pnlGbp: number; costBasisGbp: number; marketValueGbp: number; covered: number; total: number }> {
  let pnlGbp = 0, costBasisGbp = 0, marketValueGbp = 0, covered = 0;
  for (const p of positions) {
    const v = p.currentValue;
    const avg = p.averagePrice;
    const qty = p.quantity;
    if (!v || typeof v.amount !== 'number' || v.amount <= 0 || !v.currency) continue;
    if (!avg || typeof avg.amount !== 'number' || avg.amount <= 0 || !avg.currency
        || typeof qty !== 'number' || qty <= 0) continue;
    const mv = await fx.toGBP(v);
    const cb = await fx.toGBP({ amount: avg.amount * qty, currency: avg.currency });
    pnlGbp += mv - cb;
    costBasisGbp += cb;
    marketValueGbp += mv;
    covered++;
  }
  return { pnlGbp, costBasisGbp, marketValueGbp, covered, total: positions.length };
}
