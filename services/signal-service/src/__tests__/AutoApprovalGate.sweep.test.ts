import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AutoApprovalGate } from '../modules/approval/application/AutoApprovalGate.ts';
import { TradeSignal, SignalLifecycle } from '../modules/signals/domain/TradeSignal.ts';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import type { ApproveSignalUseCase } from '../modules/approval/application/ApproveSignal.ts';
import type { TradingServiceClient } from '@trader/contracts';
import type { Logger } from '@trader/core';

const stubLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => stubLogger, level: 'info',
} as unknown as Logger;

function makeSignal(id: string, action: 'BUY' | 'SELL'): TradeSignal {
  return new TradeSignal({
    id,
    timestamp: Date.now(),
    ticker: 'AAPL_US_EQ',
    strategy_id: 'factor_rank_v1',
    action,
    confidence: 0.8,
    targetWeight: 0.05,
    rationale: '{}',
    lifecycle: SignalLifecycle.Pending,
  });
}

class FakeRedis {
  private store = new Map<string, string>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string) { this.store.set(k, v); return 'OK' as const; }
  async del(k: string) { const had = this.store.delete(k); return had ? 1 : 0; }
}

class FakeRepo implements ISignalRepository {
  pending: TradeSignal[] = [];
  findByLifecycleCalls = 0;
  async save() {}
  async findById() { return null; }
  async findRecent() { return []; }
  async approve() {}
  async markExecuted() {}
  async markClosed() {}
  async findOpenBuysByTicker() { return []; }
  async decrementExecutedQuantity() {}
  async setTargetWeight() {}
  async markQueued() {}
  async claimNextQueued() { return null; }
  async requeue() {}
  async markFailed() {}
  async retry() {}
  async sweepStaleExecuting() { return 0; }
  async findByLifecycle(states: SignalLifecycle[]) {
    this.findByLifecycleCalls++;
    if (states.includes(SignalLifecycle.Pending)) return this.pending;
    return [];
  }
}

describe("AutoApprovalGate.startSweeper", () => {
  let redis: FakeRedis;
  let repo: FakeRepo;
  let approve: ApproveSignalUseCase;
  let approveCalls: string[];
  let trading: TradingServiceClient;

  beforeEach(() => {
    vi.useFakeTimers();
    redis = new FakeRedis();
    repo = new FakeRepo();
    approveCalls = [];
    approve = { execute: async (id: string) => { approveCalls.push(id); } } as unknown as ApproveSignalUseCase;
    trading = { getCash: async () => ({ free: { amount: 1000, currency: 'GBP' as const }, total: { amount: 1000, currency: 'GBP' as const } }) } as unknown as TradingServiceClient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes Pending signals picked up between cycles", async () => {
    await redis.set('signal:auto_approve', '1');
    repo.pending = [makeSignal('s1', 'SELL')];
    const gate = new AutoApprovalGate(redis as never, repo, approve, trading, stubLogger);

    const stop = gate.startSweeper(1000);
    // Immediate tick fires synchronously, but the work is async — give it a microtask flush.
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(approveCalls).toContain('s1');
    stop();
  });

  it("skips entirely when the gate flag is off", async () => {
    repo.pending = [makeSignal('s1', 'BUY')];
    const gate = new AutoApprovalGate(redis as never, repo, approve, trading, stubLogger);

    const stop = gate.startSweeper(1000);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    // findByLifecycle should not have been called — gate-off short-circuits before the query.
    expect(repo.findByLifecycleCalls).toBe(0);
    expect(approveCalls).toEqual([]);
    stop();
  });

  it("does not run a second tick while the first is still in flight", async () => {
    await redis.set('signal:auto_approve', '1');
    // Hold the approve forever to simulate a slow sweep.
    let releaseApprove!: () => void;
    const block = new Promise<void>((resolve) => { releaseApprove = resolve; });
    approve = { execute: async (id: string) => { approveCalls.push(id); await block; } } as unknown as ApproveSignalUseCase;
    repo.pending = [makeSignal('s1', 'SELL')];
    const gate = new AutoApprovalGate(redis as never, repo, approve, trading, stubLogger);

    const stop = gate.startSweeper(1000);
    // First tick fires, captures the lock.
    await vi.advanceTimersByTimeAsync(1);
    // Drive the interval to fire a second time while the first is still pending.
    await vi.advanceTimersByTimeAsync(1000);

    // Only the first invocation has called approve — the second tick was skipped.
    expect(approveCalls.length).toBe(1);
    releaseApprove();
    stop();
  });

  it("stop() prevents further ticks", async () => {
    await redis.set('signal:auto_approve', '1');
    repo.pending = [makeSignal('s1', 'SELL')];
    const gate = new AutoApprovalGate(redis as never, repo, approve, trading, stubLogger);

    const stop = gate.startSweeper(1000);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();
    const callsAfterFirstTick = repo.findByLifecycleCalls;

    stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(repo.findByLifecycleCalls).toBe(callsAfterFirstTick);
  });
});
