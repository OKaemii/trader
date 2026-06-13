// Task 17 — the Trading212Client IS the broker boundary: it is the ONLY code that produces the
// broker `_US_EQ` / `l_EQ` string (toT212, at order placement) and parses it back into a bare
// (symbol, market) identity (fromT212, on positions + order history). These tests lock that:
//   - placeMarketOrder / placeLimitOrder send the correctly-suffixed ticker built from the
//     identity (US → `_US_EQ`, LSE → `<sym>l_EQ`), with the signed quantity untouched;
//   - getPositions / getHistoricalOrders expose (symbol, market) parsed off the broker ticker,
//     with currency derived from the market (US → USD, LSE → GBP);
//   - a non-US/LSE instrument T212 reports is dropped fail-soft, never throwing the read.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Trading212Client } from '../modules/t212/infrastructure/Trading212Client.ts';

// A captured-request fetch stub: records URL + parsed body, returns the supplied JSON.
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const payload = handler(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return { calls };
}

function client() {
  return new Trading212Client({ apiKey: 'k', apiKeyId: 'id', live: false });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Trading212Client — broker boundary (toT212 on send)', () => {
  it('placeMarketOrder emits the US `_US_EQ` ticker from { symbol, market }', async () => {
    const { calls } = stubFetch(() => ({ id: 42 }));
    const res = await client().placeMarketOrder({ symbol: 'GOOGL', market: 'US' }, 3.5);
    expect(res.orderId).toBe('42');
    const order = calls.find((c) => c.url.endsWith('/equity/orders/market'))!;
    expect(order.body).toEqual({ ticker: 'GOOGL_US_EQ', quantity: 3.5 });
  });

  it('placeMarketOrder emits the LSE `<sym>l_EQ` ticker, preserving the SELL sign', async () => {
    const { calls } = stubFetch(() => ({ id: 7 }));
    await client().placeMarketOrder({ symbol: 'SHEL', market: 'LSE' }, -21.63);
    const order = calls.find((c) => c.url.endsWith('/equity/orders/market'))!;
    expect(order.body).toEqual({ ticker: 'SHELl_EQ', quantity: -21.63 });
  });

  it('placeLimitOrder emits the suffixed ticker + limitPrice + DAY validity', async () => {
    const { calls } = stubFetch(() => ({ id: 9 }));
    await client().placeLimitOrder({ symbol: 'BKG', market: 'LSE' }, -1.96, 38.5);
    const order = calls.find((c) => c.url.endsWith('/equity/orders/limit'))!;
    expect(order.body).toEqual({ ticker: 'BKGl_EQ', quantity: -1.96, limitPrice: 38.5, timeValidity: 'DAY' });
  });
});

describe('Trading212Client — broker boundary (fromT212 on parse)', () => {
  it('getPositions parses each broker ticker to (symbol, market) with market-derived currency', async () => {
    stubFetch(() => [
      { ticker: 'AAPL_US_EQ', quantity: 5, averagePrice: 100, currentPrice: 110 },
      { ticker: 'SHELl_EQ',   quantity: 3, averagePrice: 25,  currentPrice: 28 },
    ]);
    const positions = await client().getPositions();
    expect(positions).toHaveLength(2);

    const aapl = positions.find((p) => p.symbol === 'AAPL')!;
    expect(aapl).toMatchObject({ symbol: 'AAPL', market: 'US', ticker: 'AAPL_US_EQ', quantity: 5 });
    expect(aapl.currentPrice).toEqual({ amount: 110, currency: 'USD' });   // US → USD
    expect(aapl.currentValue).toEqual({ amount: 550, currency: 'USD' });

    const shel = positions.find((p) => p.symbol === 'SHEL')!;
    expect(shel).toMatchObject({ symbol: 'SHEL', market: 'LSE', ticker: 'SHELl_EQ' });
    expect(shel.averagePrice).toEqual({ amount: 25, currency: 'GBP' });    // LSE → GBP
  });

  it('getPositions drops a non-US/LSE instrument fail-soft (no throw)', async () => {
    stubFetch(() => [
      { ticker: 'AAPL_US_EQ', quantity: 5, averagePrice: 100, currentPrice: 110 },
      { ticker: 'WEIRD_CFD',  quantity: 1, averagePrice: 1,   currentPrice: 1 },
    ]);
    const positions = await client().getPositions();
    expect(positions.map((p) => p.symbol)).toEqual(['AAPL']);   // the CFD was skipped
  });

  it('getHistoricalOrders attaches (symbol, market) parsed off the order ticker', async () => {
    stubFetch(() => ({
      items: [
        { order: { id: 1, status: 'FILLED', side: 'BUY', ticker: 'AAPL_US_EQ', quantity: 5, filledQuantity: 5, type: 'MARKET', createdAt: '2026-01-01T00:00:00Z' } },
        { order: { id: 2, status: 'FILLED', side: 'SELL', ticker: 'VODl_EQ', quantity: 1, filledQuantity: 1, type: 'MARKET', createdAt: '2026-01-01T00:00:00Z' } },
      ],
      nextPagePath: null,
    }));
    const { items } = await client().getHistoricalOrders({ limit: 50 });
    expect(items[0]!.order).toMatchObject({ ticker: 'AAPL_US_EQ', symbol: 'AAPL', market: 'US' });
    expect(items[1]!.order).toMatchObject({ ticker: 'VODl_EQ', symbol: 'VOD', market: 'LSE' });
  });
});
