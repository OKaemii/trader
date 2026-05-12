export type OrderSide   = 'buy' | 'sell';
export type OrderType   = 'limit' | 'market';
export type OrderStatus = 'pending' | 'submitted' | 'filled' | 'cancelled' | 'failed';

export interface Order {
  id:            string;
  ticker:        string;
  side:          OrderSide;
  orderType:     OrderType;
  quantity:      number;
  limitPrice?:   number;
  status:        OrderStatus;
  t212OrderId?:  string;
  signalId:      string;
  targetWeight:  number;    // [0,1] — from TradeSignal; always >= 0 (long-only)
  timestamp:     number;    // Unix ms
  executedAt?:   number;
  errorMessage?: string;
}
