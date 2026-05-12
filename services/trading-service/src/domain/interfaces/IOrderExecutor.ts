import type { OrderType } from '../entities/Order.ts';

export interface OrderExecutionResult {
  t212OrderId: string;
  status:      'submitted' | 'failed';
  message?:    string;
}

export interface IOrderExecutor {
  execute(params: {
    ticker:      string;
    side:        'buy' | 'sell';
    orderType:   OrderType;
    quantity:    number;
    limitPrice?: number;
  }): Promise<OrderExecutionResult>;
}
