// Unit tests for PlaceOrderUseCase — currency-aware quantity sizing and the
// currency-mismatch reject path (the 100x bug-class guard).
//
// TRADING_MODE is read per-call inside execute(), so tests can flip it before
// invoking the use case without coordinating module load order.

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { PlaceOrderUseCase, type PlaceOrderInput } from '../application/use-cases/PlaceOrderUseCase.ts';
import { OrderStatus, OrderType } from '../domain/entities/Order.ts';
import type { Order } from '../domain/entities/Order.ts';

const originalTradingMode = process.env.TRADING_MODE;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TRADING_MODE = 'Demo';
  process.env.INTERNAL_SECRET = 'test-internal-secret';
  // notifySignalExecuted makes a real fetch to signal-service. Stub it out so the
  // use case completes cleanly without a network hop.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as any;
});

afterEach(() => {
  if (originalTradingMode === undefined) delete process.env.TRADING_MODE;
  else process.env.TRADING_MODE = originalTradingMode;
  globalThis.fetch = originalFetch;
});

function makeRepo() {
  const saved: Order[] = [];
  return {
    saved,
    async save(o: Order) { saved.push({ ...o }); },
    async findBySignalId() { return null; },
    async findRecent() { return []; },
  } as any;
}

function makeExecutor() {
  return {
    async execute(_req: unknown) {
      return { status: OrderStatus.Submitted, t212OrderId: 'tid-1' };
    },
  } as any;
}

describe('PlaceOrderUseCase', () => {
  it('returns null and logs on currency mismatch (GBP NAV vs USD price)', async () => {
    const errorSpy = mock(() => {});
    const origError = console.error;
    console.error = errorSpy;
    try {
      const useCase = new PlaceOrderUseCase(
        makeRepo(),
        makeExecutor(),
        async () => true,
        async () => OrderType.Limit,
      );
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
      expect(errorSpy).toHaveBeenCalled();
      const message = (errorSpy.mock.calls[0]?.[0] ?? '') as string;
      expect(message).toContain('currency mismatch');
      expect(message).toContain('AAPL_US_EQ');
    } finally {
      console.error = origError;
    }
  });

  it('sizes correctly when totalNAV and currentPrice currencies match (USD)', async () => {
    const useCase = new PlaceOrderUseCase(
      makeRepo(),
      makeExecutor(),
      async () => true,
      async () => OrderType.Limit,
    );
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
    const useCase = new PlaceOrderUseCase(
      makeRepo(),
      makeExecutor(),
      async () => true,
      async () => OrderType.Limit,
    );
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
    const useCase = new PlaceOrderUseCase(
      makeRepo(),
      makeExecutor(),
      async () => true,
      async () => OrderType.Limit,
    );
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
