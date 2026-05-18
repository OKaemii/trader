import { type Currency, type Money, money } from '@trader/shared-types';

const LIVE_BASE_URL = 'https://live.trading212.com/api/v0';
const DEMO_BASE_URL = 'https://demo.trading212.com/api/v0';

// T212 quotes positions in the instrument's listing currency. We derive that from the
// T212 ticker suffix because T212's portfolio response doesn't include currency on each
// position. `_US_EQ` → USD, `l_EQ` (lowercase l) → GBP. Anything else falls back to GBP
// since the account base is GBP and broker-side conversion has already happened.
export function currencyOfTicker(ticker: string): Currency {
  if (/_US_EQ$/.test(ticker)) return 'USD';
  return 'GBP';
}

export interface T212Position {
  ticker: string;
  quantity: number;
  averagePrice: Money;        // entry price, instrument currency
  currentPrice: Money;        // last quote, instrument currency
  currentValue: Money;        // currentPrice × quantity, instrument currency
}

export interface T212Cash {
  // T212 UK accounts always report cash in GBP. We carry the currency tag explicitly
  // so consumers don't have to remember "T212 = GBP" — the type system enforces it.
  free: Money;
  total: Money;
}

export interface Trading212ClientOptions {
  apiKey: string;
  apiKeyId: string;
  /** Pass `true` for live.trading212.com, `false` for demo.trading212.com. */
  live: boolean;
}

export class Trading212Client {
  private readonly headers: Record<string, string>;
  private readonly baseUrl: string;

  constructor(opts: Trading212ClientOptions) {
    const auth = 'Basic ' + Buffer.from(`${opts.apiKeyId}:${opts.apiKey}`).toString('base64');
    this.headers = { Authorization: auth, 'Content-Type': 'application/json' };
    this.baseUrl = opts.live ? LIVE_BASE_URL : DEMO_BASE_URL;
  }

  async getPortfolio(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 portfolio: ${res.status}`);
    return res.json();
  }

  async getCash(): Promise<T212Cash> {
    const res = await fetch(`${this.baseUrl}/equity/account/cash`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 cash: ${res.status}`);
    const raw = await res.json() as { free?: number; total?: number };
    const free  = Number(raw.free  ?? 0);
    const total = Number(raw.total ?? raw.free ?? 0);
    return { free: money(free, 'GBP'), total: money(total, 'GBP') };
  }

  async getPositions(): Promise<T212Position[]> {
    const res = await fetch(`${this.baseUrl}/equity/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 positions: ${res.status}`);
    const raw = await res.json() as Array<Record<string, unknown>>;
    return (raw ?? []).map((p) => {
      const ticker = String(p.ticker ?? '');
      const ccy = currencyOfTicker(ticker);
      const quantity     = Number(p.quantity ?? 0);
      const avgPriceNum  = Number(p.averagePrice ?? 0);
      const currPriceNum = Number(p.currentPrice ?? 0);
      return {
        ticker,
        quantity,
        averagePrice: money(avgPriceNum, ccy),
        currentPrice: money(currPriceNum, ccy),
        currentValue: money(currPriceNum * quantity, ccy),
      };
    });
  }

  async placeMarketOrder(ticker: string, quantity: number): Promise<{ orderId: string }> {
    // T212 rejects market orders with `timeValidity` set ("Invalid payload"); only limit orders carry it.
    const body = JSON.stringify({ ticker, quantity });
    const res  = await fetch(`${this.baseUrl}/equity/orders/market`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 market order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  async placeLimitOrder(ticker: string, quantity: number, limitPrice: number): Promise<{ orderId: string }> {
    const body = JSON.stringify({ ticker, quantity, limitPrice, timeValidity: 'DAY' });
    const res  = await fetch(`${this.baseUrl}/equity/orders/limit`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 limit order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  // Active orders — anything still working. A submitted order that drops off this list has
  // either filled or terminated. Returns raw objects; callers extract just the orderId.
  async listActiveOrders(): Promise<Array<{ id: string }>> {
    const res = await fetch(`${this.baseUrl}/equity/orders`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 list orders: ${res.status}`);
    const data = await res.json() as Array<any>;
    return (data ?? []).map((o) => ({ id: String(o.id ?? o.orderId ?? '') }));
  }

  // History of orders that have reached a terminal state (FILLED / CANCELLED / REJECTED /
  // EXPIRED). T212 paginates with `nextPagePath`, a path to follow until null. Caller drives
  // the loop. Shape confirmed via demo probe — see PROGRESS.md.
  async getHistoricalOrders(opts?: { cursor?: string; limit?: number }): Promise<{
    items:        T212HistoryItem[];
    nextPagePath: string | null;
  }> {
    const path = opts?.cursor ?? `/api/v0/equity/history/orders?limit=${opts?.limit ?? 50}`;
    const base = this.baseUrl.replace('/api/v0', '');
    const res  = await fetch(`${base}${path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 history orders: ${res.status}`);
    const data = await res.json() as { items?: T212HistoryItem[]; nextPagePath?: string | null };
    return { items: data.items ?? [], nextPagePath: data.nextPagePath ?? null };
  }
}

// Subset of fields we actually use. T212 returns more (currency, walletImpact, taxes, etc.)
// that we intentionally drop here so the structural type stays small and the tests are easy.
export interface T212HistoryItem {
  order: {
    id:             number;
    status:         string;   // 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'NEW' | ...
    side:           'BUY' | 'SELL';
    ticker:         string;
    quantity:       number;
    filledQuantity: number;
    type:           string;   // 'MARKET' | 'LIMIT' | ...
    limitPrice?:    number;
    createdAt:      string;
  };
  fill?: {
    id:            number;
    quantity:      number;
    price:         number;     // fill price in the instrument currency
    filledAt:      string;     // ISO timestamp
    tradingMethod?: string;
  };
}
