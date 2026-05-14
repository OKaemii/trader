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
  filledAt?:        number;  // Set by the fills poller when T212 confirms the fill.
  fillPrice?:       number;  // Average fill price in the instrument currency, as reported by T212.
  filledQuantity?:  number;  // T212 reports this in the history payload; useful for partial fills.
  errorMessage?: string;
}
