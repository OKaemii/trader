import type { TickerIdentity } from '@trader/ticker-identity';
import type { OrderType, OrderSide, OrderStatus } from './Order.ts';

export interface OrderExecutionResult {
  t212OrderId: string;
  // Executor outcomes are a subset of OrderStatus — only Submitted or Failed land here;
  // Filled / Cancelled / Pending are downstream states owned by the FillsPoller.
  status:      OrderStatus.Submitted | OrderStatus.Failed;
  message?:    string;
}

export interface IOrderExecutor {
  // The instrument is identified by its bare (symbol, market) — the broker string is produced
  // only inside the executor's T212 client (Task 17). Upstream holds an identity, not a ticker.
  execute(params: {
    id:          TickerIdentity;
    side:        OrderSide;
    orderType:   OrderType;
    quantity:    number;
    limitPrice?: number;
  }): Promise<OrderExecutionResult>;
}
