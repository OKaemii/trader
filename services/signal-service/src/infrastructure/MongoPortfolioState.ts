import type { IPortfolioState } from '../domain/interfaces/IPortfolioState.ts';
import type { Collection } from 'mongodb';

export class MongoPortfolioState implements IPortfolioState {
  constructor(private readonly collection: Collection) {}

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
    const positions = await this.collection.find({}).toArray();
    const nav    = positions.reduce((s: number, p: any) => s + (p.currentValue ?? 0), 0);
    const hwm    = positions.reduce((s: number, p: any) => s + (p.hwmValue ?? p.currentValue ?? 0), 0);
    if (hwm <= 0) return 0;
    return Math.max(0, (hwm - nav) / hwm);
  }
}
