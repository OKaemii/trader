// T212's /equity/orders/{market,limit} expects a signed quantity: positive = BUY,
// negative = SELL. Stripping the sign with Math.abs used to make every SELL look
// like a BUY at T212, which rejected the order with insufficient-free-for-stocks-buy
// (when cash was tight) or — worse — silently grew the position when it wasn't.
//
// Task 17: the executor identifies the instrument by its bare (symbol, market) — the broker
// `_US_EQ` / `l_EQ` string is produced only inside the T212 client. These tests assert the
// executor forwards the identity (not a ticker) to the client, with the sign convention intact.

import { describe, it, expect, vi } from "vitest";
import { T212OrderExecutor } from "../modules/t212/infrastructure/T212OrderExecutor.ts";
import { OrderSide, OrderType, OrderStatus } from "../modules/orders/domain/Order.ts";
import type { Trading212Client } from "../modules/t212/infrastructure/Trading212Client.ts";

function makeClient(overrides: Partial<Trading212Client> = {}): Trading212Client {
  return {
    placeMarketOrder: vi.fn(async () => ({ orderId: "mkt-1" })),
    placeLimitOrder:  vi.fn(async () => ({ orderId: "lim-1" })),
    ...overrides,
  } as unknown as Trading212Client;
}

describe("T212OrderExecutor", () => {
  it("forwards a US identity on BUY market orders with positive quantity", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      id: { symbol: "AAPL", market: "US" }, side: OrderSide.Buy, orderType: OrderType.Market, quantity: 3.5,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith({ symbol: "AAPL", market: "US" }, 3.5);
    expect(res.status).toBe(OrderStatus.Submitted);
  });

  it("forwards an LSE identity on SELL market orders with NEGATIVE signed quantity", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      id: { symbol: "LAND", market: "LSE" }, side: OrderSide.Sell, orderType: OrderType.Market, quantity: 21.63,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith({ symbol: "LAND", market: "LSE" }, -21.63);
    expect(res.status).toBe(OrderStatus.Submitted);
  });

  it("normalises an already-negative input on SELL (caller-supplied sign does not double-flip)", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    await executor.execute({
      id: { symbol: "CCH", market: "LSE" }, side: OrderSide.Sell, orderType: OrderType.Market, quantity: -2.81,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith({ symbol: "CCH", market: "LSE" }, -2.81);
  });

  it("submits limit orders with the same sign convention and the identity", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    await executor.execute({
      id: { symbol: "BKG", market: "LSE" }, side: OrderSide.Sell, orderType: OrderType.Limit, quantity: 1.96, limitPrice: 38.5,
    });
    expect(client.placeLimitOrder).toHaveBeenCalledWith({ symbol: "BKG", market: "LSE" }, -1.96, 38.5);
  });

  it("rejects zero-quantity orders before hitting the broker", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      id: { symbol: "AAPL", market: "US" }, side: OrderSide.Buy, orderType: OrderType.Market, quantity: 0,
    });
    expect(res.status).toBe(OrderStatus.Failed);
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
    expect(client.placeLimitOrder).not.toHaveBeenCalled();
  });
});
