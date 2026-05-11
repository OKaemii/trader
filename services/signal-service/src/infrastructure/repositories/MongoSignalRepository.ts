import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import type { TradeSignal } from '../../domain/entities/TradeSignal.ts';
import type { IDataManager } from '@trader/shared-data/interfaces/IDataManager';
import type { ICache } from '@trader/shared-data/interfaces/ICache';
import type { ICacheInvalidationBus } from '@trader/shared-data/interfaces/ICacheInvalidationBus';

export class MongoSignalRepository implements ISignalRepository {
  constructor(
    private readonly manager: IDataManager<TradeSignal>,
    private readonly cache: ICache<TradeSignal>,
    private readonly bus: ICacheInvalidationBus,
  ) {}

  async save(signal: TradeSignal): Promise<void> {
    await this.manager.insert(signal);
    await this.cache.set(signal.id, signal);
    await this.bus.publish('signals', signal.id);
  }

  async findById(id: string): Promise<TradeSignal | null> {
    return this.cache.getOrLoad(id, () => this.manager.findById(id));
  }

  async findRecent(limit: number): Promise<TradeSignal[]> {
    return this.manager.findMany({ limit, sortBy: 'timestamp', sortDir: 'desc' });
  }

  async approve(id: string): Promise<void> {
    await this.manager.update(id, { approved: true, approvedAt: new Date() });
    await this.cache.invalidate(id);
    await this.bus.publish('signals', id);
  }
}
