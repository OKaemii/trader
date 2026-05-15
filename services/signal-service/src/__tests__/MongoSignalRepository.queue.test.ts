// Tests for the new queue methods on MongoSignalRepository.
//
// We don't spin up a real Mongo here — atomic findOneAndUpdate is exercised against an
// in-memory collection stub that mimics the relevant slice of the Mongo driver API.
// The contract these tests lock in:
//   - markQueued: updates lifecycle to 'queued'
//   - claimNextQueued: returns null when empty; otherwise returns oldest queued signal
//     with lifecycle bumped to 'executing' and attempts++
//   - sweepStaleExecuting: reverts old executing rows to queued
//   - markFailed: writes lifecycle, failureReason, failureDetail
//   - retry: failed → queued, attempts reset to 0

import { describe, it, expect } from 'bun:test';
import { MongoSignalRepository } from '../infrastructure/repositories/MongoSignalRepository.ts';
import { TradeSignal } from '../domain/entities/TradeSignal.ts';
import { toSignalDoc } from '../infrastructure/data.ts';
import { SignalLifecycle, SignalFailureReason } from '@trader/shared-types';

// Minimal in-memory IDataManager + invalidation bus + cache stubs.

class MemManager {
  rows = new Map<string, any>();
  async insert(s: TradeSignal) { this.rows.set(s.id, toSignalDoc(s)); }
  async insertMany(_: TradeSignal[]) {}
  async findById(id: string): Promise<TradeSignal | null> {
    const doc = this.rows.get(id);
    if (!doc) return null;
    // Reconstruct minimal TradeSignal for tests
    return new TradeSignal({
      id: doc._id, timestamp: doc.timestamp instanceof Date ? doc.timestamp.getTime() : doc.timestamp,
      ticker: doc.ticker, strategy_id: doc.strategy_id, action: doc.action,
      confidence: doc.confidence, targetWeight: doc.targetWeight, rationale: doc.rationale,
      approved: doc.approved, lifecycle: doc.lifecycle, attempts: doc.attempts,
      failureReason: doc.failureReason, failureDetail: doc.failureDetail,
    });
  }
  async findMany() { return []; }
  async update(id: string, changes: Record<string, unknown>) {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, changes);
  }
}

class MemCache {
  store = new Map<string, any>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: any) { this.store.set(k, v); }
  async getOrLoad(_k: string, loader: any) { return loader(); }
  async invalidate(k: string) { this.store.delete(k); }
  async invalidatePattern() {}
}

class MemBus {
  events: Array<{ topic: string; key: string }> = [];
  async publish(topic: string, key: string) { this.events.push({ topic, key }); }
  async subscribe() {}
}

// In-memory Collection stub — implements just enough of the Mongo driver surface for
// findOneAndUpdate and updateMany. Sort + filter is supported because claimNextQueued
// relies on FIFO-by-timestamp ordering.
class MemCollection {
  constructor(private rows: Map<string, any>) {}
  async findOneAndUpdate(filter: any, update: any, opts: any) {
    const list = Array.from(this.rows.values()).filter((r) => this.matches(r, filter));
    if (opts?.sort) {
      const [k, dir] = Object.entries(opts.sort)[0] as [string, number];
      list.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir);
    }
    const target = list[0];
    if (!target) return null;
    if (update.$set) Object.assign(target, update.$set);
    if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) target[k] = (target[k] ?? 0) + (v as number);
    return { value: { ...target } };
  }
  async updateMany(filter: any, update: any) {
    let n = 0;
    for (const r of this.rows.values()) {
      if (this.matches(r, filter)) {
        if (update.$set) Object.assign(r, update.$set);
        n++;
      }
    }
    return { modifiedCount: n };
  }
  private matches(row: any, filter: any): boolean {
    for (const [k, v] of Object.entries(filter)) {
      if (v && typeof v === 'object' && '$lt' in (v as any)) {
        if (!(row[k] < (v as any).$lt)) return false;
      } else if (v && typeof v === 'object' && '$in' in (v as any)) {
        if (!(v as any).$in.includes(row[k])) return false;
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  }
}

function makeSignal(id: string, ts: number, lifecycle: SignalLifecycle = SignalLifecycle.Queued, attempts = 0): TradeSignal {
  return new TradeSignal({
    id, timestamp: ts, ticker: 'AAPL_US_EQ', strategy_id: 'test',
    action: 'BUY', confidence: 0.5, targetWeight: 0.01, rationale: '{}',
    lifecycle, attempts,
  });
}

function wire() {
  const manager = new MemManager();
  const cache   = new MemCache();
  const bus     = new MemBus();
  const coll    = new MemCollection(manager.rows);
  const repo    = new MongoSignalRepository(manager as any, cache as any, bus as any, coll as any);
  return { repo, manager, coll };
}

describe('MongoSignalRepository queue methods', () => {
  it('claimNextQueued returns null when none queued', async () => {
    const { repo } = wire();
    const got = await repo.claimNextQueued();
    expect(got).toBeNull();
  });

  it('claimNextQueued picks oldest by timestamp and flips to executing', async () => {
    const { repo, manager } = wire();
    await manager.insert(makeSignal('a', 200));
    await manager.insert(makeSignal('b', 100));    // older
    await manager.insert(makeSignal('c', 300));
    const got = await repo.claimNextQueued();
    expect(got?.id).toBe('b');
    expect(manager.rows.get('b').lifecycle).toBe(SignalLifecycle.Executing);
    expect(manager.rows.get('b').attempts).toBe(1);
  });

  it('markFailed records reason + detail', async () => {
    const { repo, manager } = wire();
    await manager.insert(makeSignal('x', 1));
    await repo.markFailed('x', SignalFailureReason.MarketDrift, 'delta=2.5%');
    expect(manager.rows.get('x').lifecycle).toBe(SignalLifecycle.Failed);
    expect(manager.rows.get('x').failureReason).toBe(SignalFailureReason.MarketDrift);
    expect(manager.rows.get('x').failureDetail).toBe('delta=2.5%');
  });

  it('retry clears attempts and flips failed → queued', async () => {
    const { repo, manager } = wire();
    await manager.insert(makeSignal('y', 1, SignalLifecycle.Failed, 5));
    manager.rows.get('y').failureReason = SignalFailureReason.CashInsufficient;
    await repo.retry('y');
    expect(manager.rows.get('y').lifecycle).toBe(SignalLifecycle.Queued);
    expect(manager.rows.get('y').attempts).toBe(0);
    expect(manager.rows.get('y').failureReason).toBeNull();
  });

  it('sweepStaleExecuting reverts only old executing rows', async () => {
    const { repo, manager } = wire();
    const recent = new Date();
    const old    = new Date(Date.now() - 5 * 60_000);
    await manager.insert(makeSignal('fresh', 1, SignalLifecycle.Executing));
    manager.rows.get('fresh').lastAttemptAt = recent;
    await manager.insert(makeSignal('stale', 1, SignalLifecycle.Executing));
    manager.rows.get('stale').lastAttemptAt = old;
    const reverted = await repo.sweepStaleExecuting(60_000);
    expect(reverted).toBe(1);
    expect(manager.rows.get('stale').lifecycle).toBe(SignalLifecycle.Queued);
    expect(manager.rows.get('fresh').lifecycle).toBe(SignalLifecycle.Executing);
  });
});
