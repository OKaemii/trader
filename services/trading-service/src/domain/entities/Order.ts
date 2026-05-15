// Numeric enums: comparison is `OrderType.Limit === 0` true; reverse lookup via
// `OrderType[OrderType.Limit] === 'Limit'` covers logging. Persisted to Mongo as the
// integer value — no parallel string vocabulary. NOTE: existing pre-rename rows in
// `orders` get wiped on deploy (`db.orders.deleteMany({})`); see CLAUDE.md.

export enum OrderSide {
  Buy,
  Sell,
}

export enum OrderType {
  Limit,
  Market,
}

export enum OrderStatus {
  Pending,
  Submitted,
  Filled,
  Cancelled,
  Failed,
}

export enum TradingMode {
  Paper,
  Demo,
  Live,
}

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

// Helm passes mode as the enum member name (Paper / Demo / Live) for operator
// readability; we accept the integer form too. Case-insensitive on purpose: legacy
// deployments and Terraform state files carry lowercase values ('demo' / 'live'),
// and an unrecognised string silently falling through to Paper hid a "we're not
// actually trading" bug for a while. Better to be permissive at the boundary.
export function parseTradingMode(raw: string | undefined): TradingMode {
  const v = (raw ?? '').toLowerCase();
  if (v === 'live' || v === String(TradingMode.Live))  return TradingMode.Live;
  if (v === 'demo' || v === String(TradingMode.Demo))  return TradingMode.Demo;
  if (v === 'paper' || v === '' || v === String(TradingMode.Paper)) return TradingMode.Paper;
  // Anything else is a misconfiguration — fail loud so it doesn't hide as Paper.
  throw new Error(`parseTradingMode: unrecognised TRADING_MODE='${raw}' (expected Paper/Demo/Live, case-insensitive, or integer 0/1/2)`);
}
