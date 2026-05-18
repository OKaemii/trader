// Tests for FillsPoller reconciliation against T212's /equity/orders + /equity/history/orders.
//
// Locks in the contract derived from the demo-account probe:
//   - missing from active + history.status=FILLED with `fill` payload → mark filled (real price/time)
//   - missing from active + history.status=CANCELLED/REJECTED/EXPIRED → mark cancelled
//   - missing from active but not yet in history → leave submitted
//   - still in active list → leave alone
//   - BUY fills POST to signal-service /internal/trading/signals/:id/executed with quantity
//   - SELL fills POST to signal-service /internal/trading/signals/:id/closed AND walk open
//     BUYs FIFO via /internal/trading/signals/open-buys/:ticker, closing them with
//     /closed or decrementing via /decrement-quantity at the partial-consumption boundary.
//
// INTERNAL_SECRET pinned before importing FillsPoller so generateInternalToken matches.

process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FillsPoller } from '../modules/fills/application/FillsPoller.ts';
import { type Order, OrderSide, OrderType, OrderStatus } from '../modules/orders/domain/Order.ts';
import type { IOrderRepository } from '../modules/orders/domain/IOrderRepository.ts';
import type { Trading212Client, T212HistoryItem } from '../modules/t212/infrastructure/Trading212Client.ts';
import type { Logger } from '@trader/core';
import type { SignalServiceClient, OpenBuysResponse } from '@trader/contracts';

// Stub logger that satisfies the @trader/core Logger interface.
const noopLogger: Logger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  trace: () => {}, fatal: () => {}, child: () => noopLogger, level: 'info',
} as unknown as Logger;

// Captures every SignalServiceClient call so tests can assert the wire contract without
// going through fetch. Stubs that don't override a method default to an empty/noop response.
interface CapturedCalls {
  executed: Array<{ id: string; at?: number; quantity?: number }>;
  closed:   Array<{ id: string; exitPrice: number; at?: number }>;
  decrement: Array<{ id: string; by: number }>;
  openBuysByTicker: string[];
}
function makeSignalStub(opts: { openBuys?: Record<string, OpenBuysResponse['signals']> } = {}): { client: SignalServiceClient; calls: CapturedCalls } {
  const calls: CapturedCalls = { executed: [], closed: [], decrement: [], openBuysByTicker: [] };
  const client: SignalServiceClient = {
    markExecuted: async (id, at, quantity) => {
      const entry: { id: string; at?: number; quantity?: number } = { id };
      if (at !== undefined) entry.at = at;
      if (quantity !== undefined) entry.quantity = quantity;
      calls.executed.push(entry);
      return { id, executedAt: at ?? 0, executedQuantity: quantity };
    },
    markClosed: async (id, exitPrice, at) => {
      const entry: { id: string; exitPrice: number; at?: number } = { id, exitPrice };
      if (at !== undefined) entry.at = at;
      calls.closed.push(entry);
      return { id, closedAt: at ?? 0, exitPrice };
    },
    decrementQuantity: async (id, by) => {
      calls.decrement.push({ id, by });
      return { id, decrementedBy: by };
    },
    openBuys: async (ticker) => {
      calls.openBuysByTicker.push(ticker);
      return { signals: opts.openBuys?.[ticker] ?? [] };
    },
    claimQueue:    async () => ({ signal: null }),
    requeue:       async (id) => ({ id, lifecycle: 0 }),
    failQueue:     async () => { /* noop */ },
    sweepQueue:    async () => ({ reverted: 0 }),
  } as unknown as SignalServiceClient;
  return { client, calls };
}

function makeOrder(o: Partial<Order> = {}): Order {
  return {
    id:            'order-' + (o.id ?? 'x'),
    ticker:        o.ticker ?? 'AAPL_US_EQ',
    side:          o.side ?? OrderSide.Buy,
    orderType:     o.orderType ?? OrderType.Market,
    quantity:      o.quantity ?? 2,
    status:        o.status ?? OrderStatus.Submitted,
    t212OrderId:   o.t212OrderId ?? '111',
    signalId:      o.signalId ?? 'signal-1',
    targetWeight:  o.targetWeight ?? 0.01,
    timestamp:     o.timestamp ?? Date.now() - 60_000,
    ...o,
  };
}

class StubRepo implements IOrderRepository {
  saved: Order[] = [];
  constructor(public open: Order[] = []) {}
  async save(order: Order) { this.saved.push({ ...order }); }
  async findById()        { return null; }
  async findBySignalId()  { return null; }
  async findRecent()      { return []; }
  async findOpen()        { return this.open; }
}

function makeT212(opts: {
  active?:  Array<{ id: string }>;
  history?: T212HistoryItem[];
  pages?:   Array<{ items: T212HistoryItem[]; nextPagePath: string | null }>;
}): Trading212Client {
  let pageIdx = 0;
  return {
    listActiveOrders:    async () => opts.active ?? [],
    getHistoricalOrders: async () => {
      if (opts.pages) {
        const page = opts.pages[pageIdx] ?? { items: [], nextPagePath: null };
        pageIdx++;
        return page;
      }
      return { items: opts.history ?? [], nextPagePath: null };
    },
  } as unknown as Trading212Client;
}

const filledItem = (overrides: { id: number; side?: 'BUY' | 'SELL'; price?: number; qty?: number; filledAt?: string; ticker?: string }): T212HistoryItem => ({
  order: {
    id:             overrides.id,
    status:         'FILLED',
    side:           overrides.side ?? 'BUY',
    ticker:         overrides.ticker ?? 'AAPL_US_EQ',
    quantity:       overrides.qty ?? 2,
    filledQuantity: overrides.qty ?? 2,
    type:           'MARKET',
    createdAt:      '2026-05-13T22:18:54.000Z',
  },
  fill: {
    id:        overrides.id + 1,
    quantity:  overrides.qty ?? 2,
    price:     overrides.price ?? 298.5,
    filledAt:  overrides.filledAt ?? '2026-05-13T22:19:18.000Z',
  },
});

const terminalItem = (id: number, status: 'CANCELLED' | 'REJECTED' | 'EXPIRED'): T212HistoryItem => ({
  order: {
    id, status, side: 'BUY', ticker: 'AAPL_US_EQ',
    quantity: 2, filledQuantity: 0, type: 'MARKET', createdAt: '2026-05-13T22:18:54.000Z',
  },
});

// Smarter fetch mock: matches by URL and returns programmable responses per endpoint. The
// FIFO tests need the open-buys GET to return a list, which the previous flat mock couldn't.
interface MockedFetchResponse { status?: number; body?: unknown }
function installFetchMock(handlers: Record<string, MockedFetchResponse | ((url: string, init?: RequestInit) => MockedFetchResponse)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (u.includes(pattern)) {
        const out = typeof handler === 'function' ? handler(u, init) : handler;
        return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 });
      }
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return calls;
}

describe('FillsPoller.tick', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does nothing when no orders are open', async () => {
    const repo = new StubRepo([]);
    const { client } = makeSignalStub();
    const poller = new FillsPoller(repo, makeT212({}), client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved).toHaveLength(0);
  });

  it('leaves orders untouched while they are still in active list', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '111' })]);
    const t212 = makeT212({ active: [{ id: '111' }] });
    const { client } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved).toHaveLength(0);
  });

  it('marks a BUY filled with fill.price, fill.filledAt and notifies executed with quantity', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '222', side: OrderSide.Buy, signalId: 'buy-sig' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 222, side: 'BUY', price: 250.25, qty: 5, filledAt: '2026-05-13T22:19:18.000Z' })],
    });
    const { client, calls } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(repo.saved).toHaveLength(1);
    const saved = repo.saved[0];
    expect(saved.status).toBe(OrderStatus.Filled);
    expect(saved.fillPrice).toBe(250.25);
    expect(saved.filledQuantity).toBe(5);
    expect(saved.filledAt).toBe(Date.parse('2026-05-13T22:19:18.000Z'));

    // BUY fill notifies executed with the real fill quantity, never close.
    expect(calls.executed).toContainEqual(expect.objectContaining({ id: 'buy-sig', quantity: 5 }));
    expect(calls.closed).toHaveLength(0);
  });

  it('marks a SELL filled, closes the SELL signal, and walks open BUYs FIFO to close them', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '333', side: OrderSide.Sell, signalId: 'sell-sig', ticker: 'AAPL_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 333, side: 'SELL', price: 305.0, qty: 5, ticker: 'AAPL_US_EQ' })],
    });
    // SELL of 5 shares; two BUYs with 2 + 4 shares oldest-first. Expect first BUY fully
    // closed (2), second BUY partially decremented by 3 (4 → 1).
    const { client, calls } = makeSignalStub({
      openBuys: {
        'AAPL_US_EQ': [
          { id: 'buy-1', executedQuantity: 2, executedAt: 1000 },
          { id: 'buy-2', executedQuantity: 4, executedAt: 2000 },
        ],
      },
    });
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(repo.saved[0].status).toBe(OrderStatus.Filled);
    expect(repo.saved[0].fillPrice).toBe(305.0);
    expect(calls.closed).toContainEqual(expect.objectContaining({ id: 'sell-sig', exitPrice: 305.0 }));
    expect(calls.openBuysByTicker).toContain('AAPL_US_EQ');
    expect(calls.closed).toContainEqual(expect.objectContaining({ id: 'buy-1', exitPrice: 305.0 }));
    expect(calls.decrement).toContainEqual({ id: 'buy-2', by: 3 });
    // buy-2 should NOT be closed (1 share remaining)
    expect(calls.closed.find((c) => c.id === 'buy-2')).toBeUndefined();
  });

  it('on SELL with exact match closes all matching BUYs (no decrement)', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '334', side: OrderSide.Sell, signalId: 'sell-sig-2', ticker: 'TSLA_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 334, side: 'SELL', price: 200, qty: 6, ticker: 'TSLA_US_EQ' })],
    });
    const { client, calls } = makeSignalStub({
      openBuys: {
        'TSLA_US_EQ': [
          { id: 'b1', executedQuantity: 3, executedAt: 1 },
          { id: 'b2', executedQuantity: 3, executedAt: 2 },
        ],
      },
    });
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(calls.closed.find((c) => c.id === 'b1')).toBeDefined();
    expect(calls.closed.find((c) => c.id === 'b2')).toBeDefined();
    expect(calls.decrement).toHaveLength(0);
  });

  it('on SELL with no open BUYs warns but does not error', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '335', side: OrderSide.Sell, signalId: 'sell-sig-3', ticker: 'NVDA_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 335, side: 'SELL', price: 100, qty: 1, ticker: 'NVDA_US_EQ' })],
    });
    const { client, calls } = makeSignalStub({ openBuys: { 'NVDA_US_EQ': [] } });
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    // SELL signal still gets closed even when no entry BUYs remain.
    expect(calls.closed).toContainEqual(expect.objectContaining({ id: 'sell-sig-3' }));
    // No additional BUY close/decrement calls.
    expect(calls.closed.filter((c) => c.id !== 'sell-sig-3')).toHaveLength(0);
    expect(calls.decrement).toHaveLength(0);
  });

  it('marks a cancelled order without notifying signal-service', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '444', side: OrderSide.Sell })]);
    const t212 = makeT212({
      active:  [],
      history: [terminalItem(444, 'CANCELLED')],
    });
    const { client, calls } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(repo.saved[0].status).toBe(OrderStatus.Cancelled);
    expect(repo.saved[0].filledQuantity).toBe(0);
    expect(calls.executed).toHaveLength(0);
    expect(calls.closed).toHaveLength(0);
    expect(calls.decrement).toHaveLength(0);
  });

  it('handles REJECTED and EXPIRED the same way as CANCELLED', async () => {
    const repo = new StubRepo([
      makeOrder({ id: 'a', t212OrderId: '555' }),
      makeOrder({ id: 'b', t212OrderId: '666' }),
    ]);
    const t212 = makeT212({
      active:  [],
      history: [terminalItem(555, 'REJECTED'), terminalItem(666, 'EXPIRED')],
    });
    const { client } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved.map((o) => o.status)).toEqual([OrderStatus.Cancelled, OrderStatus.Cancelled]);
  });

  it('leaves an order submitted when it is missing from both active and history (race)', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '777' })]);
    const t212 = makeT212({ active: [], history: [] });
    const { client } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved).toHaveLength(0);
  });

  it('paginates history until all wanted ids are resolved', async () => {
    const repo = new StubRepo([
      makeOrder({ id: 'a', t212OrderId: '100' }),
      makeOrder({ id: 'b', t212OrderId: '200' }),
    ]);
    const t212 = makeT212({
      active: [],
      pages: [
        { items: [filledItem({ id: 100, price: 100 })], nextPagePath: '/api/v0/equity/history/orders?cursor=p2' },
        { items: [filledItem({ id: 200, price: 200 })], nextPagePath: null },
      ],
    });
    const { client } = makeSignalStub();
    const poller = new FillsPoller(repo, t212, client, 60_000, noopLogger);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved.find((o) => o.t212OrderId === '100')?.fillPrice).toBe(100);
    expect(repo.saved.find((o) => o.t212OrderId === '200')?.fillPrice).toBe(200);
  });
});
