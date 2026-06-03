import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { COLLECTIONS } from '@trader/shared-mongo';
import type { IPieRepository, Pie, PieTarget } from '../domain/Pie.ts';

// Keep the last ~5y of monthly rebalances; older entries are dropped so the doc stays bounded.
const MAX_HISTORY = 60;

export class MongoPieRepository implements IPieRepository {
  private readonly coll: Collection<Pie>;

  constructor(db: Db) {
    this.coll = db.collection<Pie>(COLLECTIONS.PIES);
  }

  async findActiveByStrategy(strategyId: string): Promise<Pie | null> {
    return this.coll.findOne({ strategyId, status: 'active' }, { projection: { _id: 0 } }) as Promise<Pie | null>;
  }

  async findById(pieId: string): Promise<Pie | null> {
    return this.coll.findOne({ pieId }, { projection: { _id: 0 } }) as Promise<Pie | null>;
  }

  async listAll(): Promise<Pie[]> {
    return this.coll.find({}, { projection: { _id: 0 } }).sort({ updatedAt: -1 }).toArray() as Promise<Pie[]>;
  }

  async upsertActive(strategyId: string, targets: PieTarget[], at: number, reason: string): Promise<Pie> {
    const now = Date.now();
    const existing = await this.findActiveByStrategy(strategyId);
    const entry = { at, reason, targets };
    if (!existing) {
      const pie: Pie = {
        pieId: randomUUID(),
        strategyId,
        name: `${strategyId} pie`,
        status: 'active',
        baseCurrency: 'GBP',
        targets,
        rebalanceHistory: [entry],
        createdAt: now,
        updatedAt: now,
      };
      await this.coll.insertOne(pie);
      return pie;
    }
    const rebalanceHistory = [entry, ...existing.rebalanceHistory].slice(0, MAX_HISTORY);
    await this.coll.updateOne(
      { pieId: existing.pieId },
      { $set: { targets, rebalanceHistory, updatedAt: now } },
    );
    return { ...existing, targets, rebalanceHistory, updatedAt: now };
  }
}
