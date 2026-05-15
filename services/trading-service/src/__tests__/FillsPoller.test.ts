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

process.env.INTERNAL_SECRET = 'test-internal-secret';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { FillsPoller } from '../application/services/FillsPoller.ts';
import { type Order, OrderSide, OrderType, OrderStatus } from '../domain/entities/Order.ts';
import type { IOrderRepository } from '../domain/interfaces/IOrderRepository.ts';
import type { Trading212Client, T212HistoryItem } from '../infrastructure/t212.ts';

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
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
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
    mock.restore();
    globalThis.fetch = mock(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });

  it('does nothing when no orders are open', async () => {
    const repo = new StubRepo([]);
    const poller = new FillsPoller(repo, makeT212({}), 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved).toHaveLength(0);
  });

  it('leaves orders untouched while they are still in active list', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '111' })]);
    const t212 = makeT212({ active: [{ id: '111' }] });
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved).toHaveLength(0);
  });

  it('marks a BUY filled with fill.price, fill.filledAt and notifies executed with quantity', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '222', side: OrderSide.Buy, signalId: 'buy-sig' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 222, side: 'BUY', price: 250.25, qty: 5, filledAt: '2026-05-13T22:19:18.000Z' })],
    });
    const calls = installFetchMock({});
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(repo.saved).toHaveLength(1);
    const saved = repo.saved[0];
    expect(saved.status).toBe(OrderStatus.Filled);
    expect(saved.fillPrice).toBe(250.25);
    expect(saved.filledQuantity).toBe(5);
    expect(saved.filledAt).toBe(Date.parse('2026-05-13T22:19:18.000Z'));

    // BUY fill notifies /executed with the real fill quantity, NOT /closed.
    const execCall = calls.find((c) => c.url.includes('/internal/trading/signals/buy-sig/executed'));
    expect(execCall).toBeDefined();
    expect(JSON.parse((execCall!.init as RequestInit).body as string)).toMatchObject({ quantity: 5 });
    expect(calls.find((c) => c.url.includes('/closed'))).toBeUndefined();
  });

  it('marks a SELL filled, closes the SELL signal, and walks open BUYs FIFO to close them', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '333', side: OrderSide.Sell, signalId: 'sell-sig', ticker: 'AAPL_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 333, side: 'SELL', price: 305.0, qty: 5, ticker: 'AAPL_US_EQ' })],
    });
    // SELL of 5 shares; two BUYs with 2 + 4 shares oldest-first. Expect first BUY fully
    // closed (2), second BUY partially decremented by 3 (4 → 1).
    const calls = installFetchMock({
      '/internal/trading/signals/open-buys/AAPL_US_EQ': {
        body: { signals: [
          { id: 'buy-1', executedQuantity: 2, executedAt: 1000 },
          { id: 'buy-2', executedQuantity: 4, executedAt: 2000 },
        ] },
      },
    });

    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    // Order updated to filled
    expect(repo.saved[0].status).toBe(OrderStatus.Filled);
    expect(repo.saved[0].fillPrice).toBe(305.0);

    // SELL signal itself closed
    const sellClosedCall = calls.find((c) => c.url.endsWith('/internal/trading/signals/sell-sig/closed'));
    expect(sellClosedCall).toBeDefined();
    expect(JSON.parse((sellClosedCall!.init as RequestInit).body as string)).toMatchObject({ exitPrice: 305.0 });

    // open-buys lookup made
    expect(calls.some((c) => c.url.includes('/open-buys/AAPL_US_EQ'))).toBe(true);

    // First BUY (qty=2) fully consumed → /closed
    const buy1Closed = calls.find((c) => c.url.endsWith('/internal/trading/signals/buy-1/closed'));
    expect(buy1Closed).toBeDefined();
    expect(JSON.parse((buy1Closed!.init as RequestInit).body as string).exitPrice).toBe(305.0);

    // Second BUY (qty=4, only 3 remain to consume) → /decrement-quantity by 3
    const buy2Dec = calls.find((c) => c.url.endsWith('/internal/trading/signals/buy-2/decrement-quantity'));
    expect(buy2Dec).toBeDefined();
    expect(JSON.parse((buy2Dec!.init as RequestInit).body as string).by).toBe(3);

    // Second BUY should NOT be closed (still has 1 share left)
    expect(calls.find((c) => c.url.endsWith('/internal/trading/signals/buy-2/closed'))).toBeUndefined();
  });

  it('on SELL with exact match closes all matching BUYs (no decrement)', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '334', side: OrderSide.Sell, signalId: 'sell-sig-2', ticker: 'TSLA_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 334, side: 'SELL', price: 200, qty: 6, ticker: 'TSLA_US_EQ' })],
    });
    const calls = installFetchMock({
      '/internal/trading/signals/open-buys/TSLA_US_EQ': {
        body: { signals: [
          { id: 'b1', executedQuantity: 3, executedAt: 1 },
          { id: 'b2', executedQuantity: 3, executedAt: 2 },
        ] },
      },
    });
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(calls.find((c) => c.url.endsWith('/b1/closed'))).toBeDefined();
    expect(calls.find((c) => c.url.endsWith('/b2/closed'))).toBeDefined();
    expect(calls.find((c) => c.url.includes('/decrement-quantity'))).toBeUndefined();
  });

  it('on SELL with no open BUYs warns but does not error', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '335', side: OrderSide.Sell, signalId: 'sell-sig-3', ticker: 'NVDA_US_EQ' })]);
    const t212 = makeT212({
      active:  [],
      history: [filledItem({ id: 335, side: 'SELL', price: 100, qty: 1, ticker: 'NVDA_US_EQ' })],
    });
    const calls = installFetchMock({
      '/internal/trading/signals/open-buys/NVDA_US_EQ': { body: { signals: [] } },
    });
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    // SELL signal still gets closed even when no entry BUYs remain.
    expect(calls.find((c) => c.url.endsWith('/sell-sig-3/closed'))).toBeDefined();
    // No close/decrement calls for any BUY signal id.
    expect(calls.filter((c) => /\/(closed|decrement-quantity)$/.test(c.url) && !c.url.endsWith('/sell-sig-3/closed'))).toHaveLength(0);
  });

  it('marks a cancelled order without notifying signal-service', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '444', side: OrderSide.Sell })]);
    const t212 = makeT212({
      active:  [],
      history: [terminalItem(444, 'CANCELLED')],
    });
    const calls = installFetchMock({});
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();

    expect(repo.saved[0].status).toBe(OrderStatus.Cancelled);
    expect(repo.saved[0].filledQuantity).toBe(0);
    expect(calls).toHaveLength(0);
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
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved.map((o) => o.status)).toEqual([OrderStatus.Cancelled, OrderStatus.Cancelled]);
  });

  it('leaves an order submitted when it is missing from both active and history (race)', async () => {
    const repo = new StubRepo([makeOrder({ t212OrderId: '777' })]);
    const t212 = makeT212({ active: [], history: [] });
    const poller = new FillsPoller(repo, t212, 60_000);
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
    const poller = new FillsPoller(repo, t212, 60_000);
    await (poller as unknown as { tick: () => Promise<void> }).tick();
    expect(repo.saved.find((o) => o.t212OrderId === '100')?.fillPrice).toBe(100);
    expect(repo.saved.find((o) => o.t212OrderId === '200')?.fillPrice).toBe(200);
  });
});
