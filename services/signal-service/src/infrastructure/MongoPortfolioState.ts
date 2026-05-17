import type { IPortfolioState } from '../domain/interfaces/IPortfolioState.ts';
import type { Collection } from 'mongodb';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';

export class MongoPortfolioState implements IPortfolioState {
  constructor(
    private readonly collection: Collection,
    private readonly fx: FxConverter,
  ) {}

  async currentWeights(): Promise<Record<string, number>> {
    const positions = await this.collection.find({}).toArray();
    const weights: Record<string, number> = {};
    for (const pos of positions) {
      if (pos.ticker && typeof pos.weight === 'number') {
        weights[pos.ticker as string] = pos.weight as number;
      }
    }
    return weights;
  }

  async currentDrawdown(): Promise<number> {
    const positions = await this.collection.find({}).toArray() as unknown as PositionDoc[];
    // NAV in GBP via the single read-side helper. If FX is unavailable, returning 0
    // is safer than tripping the drawdown breaker on bad data — the next cycle will
    // recompute once FX recovers.
    let nav = 0;
    try { nav = await sumPositionsGBP(positions, this.fx); }
    catch (err) {
      console.warn('[MongoPortfolioState] FX unavailable for drawdown, returning 0:', err);
      return 0;
    }
    // HWM is recorded as a GBP scalar per-position (renamed from the pre-FX `hwmValue`
    // field, which suffered the same mixed-currency bug as the now-removed `currentValue`
    // summation). No writer exists today; the field is read here for forward compatibility.
    const hwm = positions.reduce((s: number, p: any) =>
      s + (typeof p.hwmGBP === 'number' ? p.hwmGBP : 0), 0);
    if (hwm <= 0) return 0;
    return Math.max(0, (hwm - nav) / hwm);
  }
}
