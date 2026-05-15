// Helm passes TRADING_MODE as the enum member name ('Live'/'Demo'/'Paper'). We compare
// against the string here rather than importing TradingMode to keep this file dependency-
// free — it's the lowest-level infrastructure module.
function t212Base(): string {
  return process.env.TRADING_MODE === 'Live'
    ? 'https://live.trading212.com/api/v0'
    : 'https://demo.trading212.com/api/v0';
}

export class Trading212Client {
  private headers: Record<string, string>;

  constructor(apiKey: string, apiKeyId: string) {
    const auth = 'Basic ' + Buffer.from(`${apiKeyId}:${apiKey}`).toString('base64');
    this.headers = { Authorization: auth, 'Content-Type': 'application/json' };
  }

  async getPortfolio(): Promise<unknown> {
    const res = await fetch(`${t212Base()}/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 portfolio: ${res.status}`);
    return res.json();
  }

  async getCash(): Promise<{ free: number; total: number }> {
    const res = await fetch(`${t212Base()}/equity/account/cash`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 cash: ${res.status}`);
    return res.json();
  }

  async getPositions(): Promise<unknown[]> {
    const res = await fetch(`${t212Base()}/equity/portfolio`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 positions: ${res.status}`);
    return res.json();
  }

  async placeMarketOrder(ticker: string, quantity: number): Promise<{ orderId: string }> {
    // T212 rejects market orders with `timeValidity` set ("Invalid payload"); only limit orders carry it.
    const body = JSON.stringify({ ticker, quantity });
    const res  = await fetch(`${t212Base()}/equity/orders/market`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 market order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  async placeLimitOrder(ticker: string, quantity: number, limitPrice: number): Promise<{ orderId: string }> {
    const body = JSON.stringify({ ticker, quantity, limitPrice, timeValidity: 'DAY' });
    const res  = await fetch(`${t212Base()}/equity/orders/limit`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 limit order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  // Active orders — anything still working. A submitted order that drops off this list has
  // either filled or terminated. Returns raw objects; callers extract just the orderId.
  async listActiveOrders(): Promise<Array<{ id: string }>> {
    const res = await fetch(`${t212Base()}/equity/orders`, { headers: this.headers });
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
    const base = t212Base().replace('/api/v0', '');
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
