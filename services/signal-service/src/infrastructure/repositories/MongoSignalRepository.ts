import type { Collection } from 'mongodb';
import type { ISignalRepository } from '../../domain/interfaces/ISignalRepository.ts';
import { TradeSignal, SignalFailureReason, SignalLifecycle } from '../../domain/entities/TradeSignal.ts';
import type { IDataManager } from '@trader/shared-data/interfaces/IDataManager';
import type { ICache } from '@trader/shared-data/interfaces/ICache';
import type { ICacheInvalidationBus } from '@trader/shared-data/interfaces/ICacheInvalidationBus';
import { fromSignalDoc } from '../data.ts';

export class MongoSignalRepository implements ISignalRepository {
  constructor(
    private readonly manager: IDataManager<TradeSignal>,
    private readonly cache: ICache<TradeSignal>,
    private readonly bus: ICacheInvalidationBus,
    // Optional raw-collection handle. Required for queue methods (claimNextQueued,
    // sweepStaleExecuting) which use atomic findOneAndUpdate that IDataManager doesn't
    // expose. Older call sites that only use save/find/markExecuted can omit it.
    private readonly collection?: Collection,
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
      lifecycle: SignalLifecycle.Approved,
    });
    await this.invalidate(id);
  }

  async markExecuted(id: string, at: number, executedQuantity?: number): Promise<void> {
    const changes: Record<string, unknown> = {
      executedAt: new Date(at),
      lifecycle: SignalLifecycle.Executed,
    };
    if (typeof executedQuantity === 'number') changes.executedQuantity = executedQuantity;
    await this.manager.update(id, changes);
    await this.invalidate(id);
  }

  async markClosed(id: string, at: number, exitPrice: number): Promise<void> {
    await this.manager.update(id, {
      closedAt: new Date(at),
      exitPrice,
      lifecycle: SignalLifecycle.Closed,
    });
    await this.invalidate(id);
  }

  async findOpenBuysByTicker(ticker: string): Promise<TradeSignal[]> {
    return this.manager.findMany({
      filter: { ticker, action: 'BUY', lifecycle: SignalLifecycle.Executed },
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

  async markQueued(id: string): Promise<void> {
    await this.manager.update(id, { lifecycle: SignalLifecycle.Queued });
    await this.invalidate(id);
  }

  async claimNextQueued(): Promise<TradeSignal | null> {
    if (!this.collection) throw new Error('claimNextQueued requires raw collection handle');
    // Atomic FIFO claim. findOneAndUpdate with sort makes this safe under multi-pod
    // dispatcher (only one pod wins the row). attempts increments here, not on requeue,
    // so retry exhaustion is counted correctly even if a worker dies mid-call.
    const now = new Date();
    const res = await this.collection.findOneAndUpdate(
      { lifecycle: SignalLifecycle.Queued },
      {
        $set: { lifecycle: SignalLifecycle.Executing, lastAttemptAt: now },
        $inc: { attempts: 1 },
      },
      { sort: { timestamp: 1 }, returnDocument: 'after' },
    );
    const doc = (res as any)?.value ?? res;
    if (!doc) return null;
    const signal = fromSignalDoc(doc);
    await this.invalidate(signal.id);
    return signal;
  }

  async requeue(id: string): Promise<void> {
    await this.manager.update(id, { lifecycle: SignalLifecycle.Queued });
    await this.invalidate(id);
  }

  async markFailed(id: string, reason: SignalFailureReason, detail?: string): Promise<void> {
    const changes: Record<string, unknown> = {
      lifecycle: SignalLifecycle.Failed,
      failureReason: reason,
    };
    if (detail) changes.failureDetail = detail;
    await this.manager.update(id, changes);
    await this.invalidate(id);
  }

  async retry(id: string): Promise<void> {
    await this.manager.update(id, {
      lifecycle: SignalLifecycle.Queued,
      attempts: 0,
      failureReason: null,
      failureDetail: null,
    });
    await this.invalidate(id);
  }

  async sweepStaleExecuting(thresholdMs: number): Promise<number> {
    if (!this.collection) throw new Error('sweepStaleExecuting requires raw collection handle');
    const cutoff = new Date(Date.now() - thresholdMs);
    const res = await this.collection.updateMany(
      { lifecycle: SignalLifecycle.Executing, lastAttemptAt: { $lt: cutoff } },
      { $set: { lifecycle: SignalLifecycle.Queued } },
    );
    // Cache invalidation is best-effort: a wildcard publish notifies subscribers to drop
    // their per-id entries. The dispatcher reads via claimNextQueued which goes direct to
    // Mongo, so a momentary stale cache cannot cause double-execution.
    await this.bus.publish('signals', '*');
    return res.modifiedCount ?? 0;
  }

  async findByLifecycle(states: SignalLifecycle[], limit: number): Promise<TradeSignal[]> {
    return this.manager.findMany({
      filter: { lifecycle: { $in: states } } as any,
      sortBy: 'timestamp',
      sortDir: 'desc',
      limit,
    });
  }

  private async invalidate(id: string): Promise<void> {
    await this.cache.invalidate(id);
    await this.bus.publish('signals', id);
  }
}
