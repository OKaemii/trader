import { describe, it, expect } from "vitest";
import { GetSignalProgressUseCase } from '../modules/signals/application/GetSignalProgress.ts';
import { TradeSignal } from '../modules/signals/domain/TradeSignal.ts';
import { SignalLifecycle } from '@trader/shared-types';
import type { ISignalRepository } from '../modules/signals/domain/ISignalRepository.ts';
import type { IPortfolioState } from '../modules/risk/application/IPortfolioState.ts';
import type { IPriceLookup } from '../modules/signals/domain/IPriceLookup.ts';

class StubRepo implements ISignalRepository {
  constructor(private signals: TradeSignal[]) {}
  async save() {}
  async findById() { return null; }
  async findRecent() { return this.signals; }
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
  async findByLifecycle() { return []; }
}

class StubPortfolio implements IPortfolioState {
  constructor(private w: Record<string, number>) {}
  async currentWeights() { return this.w; }
  async currentDrawdown() { return 0; }
}

class StubPrices implements IPriceLookup {
  constructor(private p: Record<string, number | null>) {}
  async lastClose(t: string) { return this.p[t] ?? null; }
  async lastCloseMany(tickers: string[]) {
    const out: Record<string, number | null> = {};
    for (const t of tickers) out[t] = this.p[t] ?? null;
    return out;
  }
}

const sig = (overrides: Partial<{ ticker: string; action: 'BUY' | 'SELL'; entry: number; ts: number; lifecycle: SignalLifecycle }>) =>
  new TradeSignal({
    id: overrides.ticker ?? 'id1',
    timestamp: overrides.ts ?? Date.now() - 1000,
    ticker: overrides.ticker ?? 'AAPL',
    strategy_id: 'factor_rank_v1',
    action: overrides.action ?? 'BUY',
    confidence: 0.5,
    targetWeight: 0.2,
    rationale: '{}',
    entryPrice: overrides.entry,
    lifecycle: overrides.lifecycle,
  });

describe('GetSignalProgressUseCase', () => {
  it('returns empty when no signals', async () => {
    const uc = new GetSignalProgressUseCase(new StubRepo([]), new StubPortfolio({}), new StubPrices({}));
    expect(await uc.execute(50)).toEqual([]);
  });

  it('computes BUY P&L from entry to current', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'AAPL', action: 'BUY', entry: 100 })]),
      new StubPortfolio({ AAPL: 0.05 }),
      new StubPrices({ AAPL: 110 }),
    );
    const [row] = await uc.execute(50);
    expect(row.pnlPct).toBeCloseTo(0.1);
    expect(row.currentPrice).toBe(110);
    expect(row.currentWeight).toBe(0.05);
  });

  it('SELL P&L is inverted', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'TSLA', action: 'SELL', entry: 200 })]),
      new StubPortfolio({}),
      new StubPrices({ TSLA: 180 }),
    );
    const [row] = await uc.execute(50);
    expect(row.pnlPct).toBeCloseTo(0.1);
    expect(row.action).toBe('SELL');
  });

  it('null pnl when entryPrice missing', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'MSFT' })]),
      new StubPortfolio({}),
      new StubPrices({ MSFT: 400 }),
    );
    const [row] = await uc.execute(50);
    expect(row.pnlPct).toBeNull();
  });

  it('null pnl when current price missing', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'XYZ', entry: 50 })]),
      new StubPortfolio({}),
      new StubPrices({ XYZ: null }),
    );
    const [row] = await uc.execute(50);
    expect(row.pnlPct).toBeNull();
    expect(row.currentPrice).toBeNull();
  });

  it('currentWeight defaults to 0 when ticker not held', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'NEW', entry: 10 })]),
      new StubPortfolio({ AAPL: 0.5 }),
      new StubPrices({ NEW: 12 }),
    );
    const [row] = await uc.execute(50);
    expect(row.currentWeight).toBe(0);
  });

  it('ageMs derived from now - signal.timestamp', async () => {
    const ts = 1_000_000;
    const now = 1_500_000;
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'AAPL', entry: 100, ts })]),
      new StubPortfolio({}),
      new StubPrices({ AAPL: 100 }),
      () => now,
    );
    const [row] = await uc.execute(50);
    expect(row.ageMs).toBe(500_000);
  });

  it('lifecycleResolved falls through entity default when not stored', async () => {
    const uc = new GetSignalProgressUseCase(
      new StubRepo([sig({ ticker: 'AAPL', entry: 100 })]),
      new StubPortfolio({}),
      new StubPrices({ AAPL: 100 }),
    );
    const [row] = await uc.execute(50);
    expect(row.lifecycleResolved).toBe(SignalLifecycle.Pending);
  });
});
