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
    await this.manager.update(id, {
      approved: true,
      approvedAt: new Date(),
      lifecycle: 'approved',
    });
    await this.invalidate(id);
  }

  async markExecuted(id: string, at: number, executedQuantity?: number): Promise<void> {
    const changes: Record<string, unknown> = {
      executedAt: new Date(at),
      lifecycle: 'executed',
    };
    if (typeof executedQuantity === 'number') changes.executedQuantity = executedQuantity;
    await this.manager.update(id, changes);
    await this.invalidate(id);
  }

  async markClosed(id: string, at: number, exitPrice: number): Promise<void> {
    await this.manager.update(id, {
      closedAt: new Date(at),
      exitPrice,
      lifecycle: 'closed',
    });
    await this.invalidate(id);
  }

  async findOpenBuysByTicker(ticker: string): Promise<TradeSignal[]> {
    return this.manager.findMany({
      filter: { ticker, action: 'BUY', lifecycle: 'executed' },
      sortBy: 'executedAt',
      sortDir: 'asc',
      limit: 200,
    });
  }

  async decrementExecutedQuantity(id: string, by: number): Promise<void> {
    if (by <= 0) return;
    const sig = await this.manager.findById(id);
    if (!sig) return;
    const next = Math.max(0, (sig.executedQuantity ?? 0) - by);
    await this.manager.update(id, { executedQuantity: next });
    await this.invalidate(id);
  }

  async setTargetWeight(id: string, targetWeight: number): Promise<void> {
    if (targetWeight < 0) return;
    await this.manager.update(id, { targetWeight });
    await this.invalidate(id);
  }

  private async invalidate(id: string): Promise<void> {
    await this.cache.invalidate(id);
    await this.bus.publish('signals', id);
  }
}
