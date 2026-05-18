// Unit tests for PlaceOrderUseCase — currency-aware quantity sizing and the
// currency-mismatch reject path (the 100x bug-class guard).

import { describe, it, expect, vi } from "vitest";
import { PlaceOrderUseCase, type PlaceOrderInput } from '../modules/orders/application/PlaceOrderUseCase.ts';
import { OrderStatus, OrderType, TradingMode } from '../modules/orders/domain/Order.ts';
import type { Order } from '../modules/orders/domain/Order.ts';
import type { Logger } from '@trader/core';
import type { SignalServiceClient } from '@trader/contracts';

const logCalls = { error: [] as unknown[][] };
const captureLogger: Logger = {
  info:  () => {}, warn: () => {}, debug: () => {}, trace: () => {}, fatal: () => {},
  error: (...args: unknown[]) => { logCalls.error.push(args); },
  child: () => captureLogger,
  level: 'info',
} as unknown as Logger;

function noopSignal(): SignalServiceClient {
  return {
    markExecuted: async () => ({ id: '', executedAt: 0 }),
    markClosed:   async () => ({ id: '', closedAt: 0, exitPrice: 0 }),
    decrementQuantity: async () => ({ id: '', decrementedBy: 0 }),
    openBuys:     async () => ({ signals: [] }),
    claimQueue:   async () => ({ signal: null }),
    requeue:      async () => ({ id: '', lifecycle: 0 }),
    failQueue:    async () => { /* noop */ },
    sweepQueue:   async () => ({ reverted: 0 }),
  } as unknown as SignalServiceClient;
}

function makeRepo() {
  const saved: Order[] = [];
  return {
    saved,
    async save(o: Order) { saved.push({ ...o }); },
    async findBySignalId() { return null; },
    async findRecent() { return []; },
  } as never;
}

function makeExecutor() {
  return {
    async execute(_req: unknown) {
      return { status: OrderStatus.Submitted, t212OrderId: 'tid-1' };
    },
  } as never;
}

function makeUseCase(opts: { logger?: Logger } = {}) {
  return new PlaceOrderUseCase({
    orderRepo:   makeRepo(),
    executor:    makeExecutor(),
    liveApproved: async () => true,
    signal:      noopSignal(),
    logger:      opts.logger ?? captureLogger,
    tradingMode: TradingMode.Demo,
    getSignalOrderType: async () => OrderType.Limit,
  });
}

describe('PlaceOrderUseCase', () => {
  it('returns null and logs on currency mismatch (GBP NAV vs USD price)', async () => {
    logCalls.error = [];
    const useCase = makeUseCase();
    const input: PlaceOrderInput = {
      signalId:        'sig-mismatch',
      ticker:          'AAPL_US_EQ',
      action:          'BUY',
      targetWeight:    0.05,
      confidence:      0.7,
      // Bug class: caller forgot to FX-convert GBP NAV into USD before sizing.
      totalNAV:        { amount: 100_000, currency: 'GBP' },
      currentPrice:    { amount: 200,     currency: 'USD' },
      currentQuantity: 0,
    };
    const order = await useCase.execute(input);
    expect(order).toBeNull();
    expect(logCalls.error.length).toBeGreaterThan(0);
    const ctx = logCalls.error[0]?.[0] as Record<string, unknown>;
    expect(ctx.ticker).toBe('AAPL_US_EQ');
    expect(ctx.totalNAV).toBe('GBP');
    expect(ctx.currentPrice).toBe('USD');
  });

  it('sizes correctly when totalNAV and currentPrice currencies match (USD)', async () => {
    const useCase = makeUseCase();
    const order = await useCase.execute({
      signalId:        'sig-usd',
      ticker:          'AAPL_US_EQ',
      action:          'BUY',
      targetWeight:    0.10,
      confidence:      0.7,
      totalNAV:        { amount: 100_000, currency: 'USD' },
      currentPrice:    { amount: 200,     currency: 'USD' },
      currentQuantity: 0,
    });
    expect(order).not.toBeNull();
    // 10% of 100k = 10k → 10k / 200 = 50 shares (floored).
    expect(order!.quantity).toBe(50);
    expect(order!.limitPrice).toBe(200);
  });

  it('sizes correctly for GBP-only inputs (LSE listing)', async () => {
    const useCase = makeUseCase();
    const order = await useCase.execute({
      signalId:        'sig-gbp',
      ticker:          'VODl_EQ',
      action:          'BUY',
      targetWeight:    0.04,
      confidence:      0.7,
      totalNAV:        { amount: 50_000, currency: 'GBP' },
      currentPrice:    { amount: 80,     currency: 'GBP' },
      currentQuantity: 0,
    });
    expect(order).not.toBeNull();
    // 4% of 50k = 2k → 2k / 80 = 25 shares.
    expect(order!.quantity).toBe(25);
  });

  it('returns null when currentPrice is missing', async () => {
    const useCase = makeUseCase();
    const order = await useCase.execute({
      signalId:     'sig-noprice',
      ticker:       'AAPL_US_EQ',
      action:       'BUY',
      targetWeight: 0.05,
      confidence:   0.7,
      totalNAV:     { amount: 100_000, currency: 'USD' },
    });
    expect(order).toBeNull();
  });
});
