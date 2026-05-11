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
}
