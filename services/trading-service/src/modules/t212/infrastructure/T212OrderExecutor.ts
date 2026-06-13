import type { TickerIdentity } from '@trader/ticker-identity';
import type { IOrderExecutor, OrderExecutionResult } from '../../orders/domain/IOrderExecutor.ts';
import { OrderSide, OrderType, OrderStatus } from '../../orders/domain/Order.ts';
import type { Trading212Client } from './Trading212Client.ts';

export class T212OrderExecutor implements IOrderExecutor {
  constructor(private readonly client: Trading212Client) {}

  async execute(params: {
    // The order is described by its bare identity (symbol, market); the client converts to the
    // broker string via toT212 at the send. The executor never touches the _US_EQ / l_EQ form.
    id:          TickerIdentity;
    side:        OrderSide;
    orderType:   OrderType;
    quantity:    number;
    limitPrice?: number;
  }): Promise<OrderExecutionResult> {
    // T212's /equity/orders/{market,limit} uses a signed quantity: positive = BUY,
    // negative = SELL. Stripping the sign with Math.abs submitted every SELL as a
    // BUY, which T212 rejected with `/api-errors/insufficient-free-for-stocks-buy`
    // when cash was tight or — worse — executed as an additional BUY when it wasn't.
    const magnitude = Math.abs(params.quantity);
    if (magnitude === 0) return { t212OrderId: '', status: OrderStatus.Failed, message: 'quantity is 0' };
    const signedQty = params.side === OrderSide.Sell ? -magnitude : magnitude;

    if (params.orderType === OrderType.Limit && params.limitPrice) {
      const result = await this.client.placeLimitOrder(params.id, signedQty, params.limitPrice);
      return { t212OrderId: result.orderId, status: OrderStatus.Submitted };
    } else {
      const result = await this.client.placeMarketOrder(params.id, signedQty);
      return { t212OrderId: result.orderId, status: OrderStatus.Submitted };
    }
  }
}
