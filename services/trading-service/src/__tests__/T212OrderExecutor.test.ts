// T212's /equity/orders/{market,limit} expects a signed quantity: positive = BUY,
// negative = SELL. Stripping the sign with Math.abs used to make every SELL look
// like a BUY at T212, which rejected the order with insufficient-free-for-stocks-buy
// (when cash was tight) or — worse — silently grew the position when it wasn't.

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
  it("submits BUY market orders with positive quantity", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      ticker: "AAPL_US_EQ", side: OrderSide.Buy, orderType: OrderType.Market, quantity: 3.5,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith("AAPL_US_EQ", 3.5);
    expect(res.status).toBe(OrderStatus.Submitted);
  });

  it("submits SELL market orders with NEGATIVE signed quantity", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      ticker: "LANDl_EQ", side: OrderSide.Sell, orderType: OrderType.Market, quantity: 21.63,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith("LANDl_EQ", -21.63);
    expect(res.status).toBe(OrderStatus.Submitted);
  });

  it("normalises an already-negative input on SELL (caller-supplied sign does not double-flip)", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    await executor.execute({
      ticker: "CCHl_EQ", side: OrderSide.Sell, orderType: OrderType.Market, quantity: -2.81,
    });
    expect(client.placeMarketOrder).toHaveBeenCalledWith("CCHl_EQ", -2.81);
  });

  it("submits limit orders with the same sign convention", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    await executor.execute({
      ticker: "BKGl_EQ", side: OrderSide.Sell, orderType: OrderType.Limit, quantity: 1.96, limitPrice: 38.5,
    });
    expect(client.placeLimitOrder).toHaveBeenCalledWith("BKGl_EQ", -1.96, 38.5);
  });

  it("rejects zero-quantity orders before hitting the broker", async () => {
    const client   = makeClient();
    const executor = new T212OrderExecutor(client);
    const res = await executor.execute({
      ticker: "AAPL_US_EQ", side: OrderSide.Buy, orderType: OrderType.Market, quantity: 0,
    });
    expect(res.status).toBe(OrderStatus.Failed);
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
    expect(client.placeLimitOrder).not.toHaveBeenCalled();
  });
});
