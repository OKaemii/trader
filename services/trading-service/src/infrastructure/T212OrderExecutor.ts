import type { IOrderExecutor, OrderExecutionResult } from '../domain/interfaces/IOrderExecutor.ts';
import { OrderSide, OrderType, OrderStatus } from '../domain/entities/Order.ts';
import type { Trading212Client } from './t212.ts';

export class T212OrderExecutor implements IOrderExecutor {
  constructor(private readonly client: Trading212Client) {}

  async execute(params: {
    ticker:      string;
    side:        OrderSide;
    orderType:   OrderType;
    quantity:    number;
    limitPrice?: number;
  }): Promise<OrderExecutionResult> {
    // Long-only: selling means reducing/exiting a long position — quantity must be positive
    const qty = Math.abs(params.quantity);
    if (qty === 0) return { t212OrderId: '', status: OrderStatus.Failed, message: 'quantity is 0' };

    if (params.orderType === OrderType.Limit && params.limitPrice) {
      const result = await this.client.placeLimitOrder(params.ticker, qty, params.limitPrice);
      return { t212OrderId: result.orderId, status: OrderStatus.Submitted };
    } else {
      const result = await this.client.placeMarketOrder(params.ticker, qty);
      return { t212OrderId: result.orderId, status: OrderStatus.Submitted };
    }
  }
}
