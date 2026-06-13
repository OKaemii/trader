import type { IPortfolioState } from '../application/IPortfolioState.ts';
import type { Collection } from 'mongodb';
import type { Logger } from '@trader/core';
import { sumPositionsGBP, type FxConverter, type PositionDoc } from '@trader/shared-portfolio';
import { tickerOf } from '../../../shared/identity.ts';

export class MongoPortfolioState implements IPortfolioState {
  constructor(
    private readonly collection: Collection,
    private readonly fx: FxConverter,
    private readonly logger?: Logger,
  ) {}

  async currentWeights(): Promise<Record<string, number>> {
    const positions = await this.collection.find({}).toArray();
    const weights: Record<string, number> = {};
    for (const pos of positions) {
      if (typeof pos.weight !== 'number') continue;
      // Positions are keyed on (symbol, market) since Task 16a; re-derive the T212 ticker so the
      // returned weights map stays keyed the way GenerateSignals reads it (against the still-T212
      // ticker_universe). A legacy row that still carries a bare `ticker` falls back to it.
      let ticker: string | undefined;
      if (typeof pos.symbol === 'string' && typeof pos.market === 'string') {
        try { ticker = tickerOf(pos.symbol, pos.market); } catch { ticker = undefined; }
      }
      if (!ticker && typeof pos.ticker === 'string') ticker = pos.ticker;
      if (ticker) weights[ticker] = pos.weight as number;
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
      this.logger?.warn({ err }, 'FX unavailable for drawdown, returning 0');
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
