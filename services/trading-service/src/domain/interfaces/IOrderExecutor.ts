import type { OrderType, OrderSide, OrderStatus } from '../entities/Order.ts';

export interface OrderExecutionResult {
  t212OrderId: string;
  // Executor outcomes are a subset of OrderStatus — only Submitted or Failed land here;
  // Filled / Cancelled / Pending are downstream states owned by the FillsPoller.
  status:      OrderStatus.Submitted | OrderStatus.Failed;
  message?:    string;
}

export interface IOrderExecutor {
  execute(params: {
    ticker:      string;
    side:        OrderSide;
    orderType:   OrderType;
    quantity:    number;
    limitPrice?: number;
  }): Promise<OrderExecutionResult>;
}
