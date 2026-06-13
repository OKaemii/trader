import { type Money, money } from '@trader/shared-types';
import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';

const LIVE_BASE_URL = 'https://live.trading212.com/api/v0';
const DEMO_BASE_URL = 'https://demo.trading212.com/api/v0';

// This client IS the Trading212 broker boundary (Thread A, Task 17): it is the only code
// that turns a bare (symbol, market) identity into the broker's `_US_EQ` / `l_EQ` string on
// the way out (`toT212` at order placement) and parses a broker response back into a bare
// identity on the way in (`fromT212` on positions / order history). Currency is derived from
// the listing `market` via the adapter — T212's portfolio response carries no per-position
// currency, and the market is its sole determinant (US → USD, LSE → GBP).
const adapter = new Trading212TickerAdapter();

export interface T212Position {
  // Bare identity is the source of truth (parsed off the broker ticker via the adapter);
  // `ticker` is the re-derived broker string, kept for the consumers that still log / key on
  // it (reconciliation, the pence-kill scaler) until they migrate to (symbol, market).
  symbol: string;
  market: TickerIdentity['market'];
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
    const out: T212Position[] = [];
    for (const p of raw ?? []) {
      const t212Ticker = String(p.ticker ?? '');
      // Parse the broker ticker back into the bare identity HERE, at the boundary. A position
      // T212 reports for a non-US/LSE instrument (an exotic CFD) doesn't parse — skip it
      // fail-soft rather than throwing the whole portfolio read (the sizing/reconciliation
      // paths then just don't see that name).
      const id = tryFromT212(t212Ticker);
      if (!id) continue;
      const ccy = adapter.currencyOf(id);
      const quantity     = Number(p.quantity ?? 0);
      const avgPriceNum  = Number(p.averagePrice ?? 0);
      const currPriceNum = Number(p.currentPrice ?? 0);
      out.push({
        symbol: id.symbol,
        market: id.market,
        ticker: adapter.toT212(id),
        quantity,
        averagePrice: money(avgPriceNum, ccy),
        currentPrice: money(currPriceNum, ccy),
        currentValue: money(currPriceNum * quantity, ccy),
      });
    }
    return out;
  }

  async placeMarketOrder(id: TickerIdentity, quantity: number): Promise<{ orderId: string }> {
    // The broker string is produced HERE, at the send — toT212 is called nowhere else on the
    // order-placement path. T212 rejects market orders with `timeValidity` set ("Invalid
    // payload"); only limit orders carry it.
    const ticker = adapter.toT212(id);
    const body = JSON.stringify({ ticker, quantity });
    const res  = await fetch(`${this.baseUrl}/equity/orders/market`, {
      method: 'POST', headers: this.headers, body,
    });
    if (!res.ok) throw new Error(`T212 market order: ${res.status} ${await res.text()}`);
    const data = await res.json() as any;
    return { orderId: String(data.id ?? data.orderId ?? 'unknown') };
  }

  async placeLimitOrder(id: TickerIdentity, quantity: number, limitPrice: number): Promise<{ orderId: string }> {
    const ticker = adapter.toT212(id);
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

  // Cancel a resting order (DELETE /equity/orders/{id}). 404 = already gone (filled/cancelled) —
  // tolerated so the flatten path is idempotent. Used by FlattenAllUseCase.
  async cancelOrder(orderId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/equity/orders/${orderId}`, { method: 'DELETE', headers: this.headers });
    if (!res.ok && res.status !== 404) throw new Error(`T212 cancel order ${orderId}: ${res.status}`);
  }

  // Instrument metadata — per-ticker quantity rules. T212 returns a large array (typ.
  // 5k+ instruments, several MB). Fetch once on boot and cache; the metadata changes only
  // when T212 adds/removes tickers, which is rare. minTradeQuantity also implicitly defines
  // the allowed quantity precision (number of decimals). Without this, our dispatcher sends
  // 4-decimal quantities and the broker rejects with `quantity-precision-mismatch` or
  // `min-quantity-exceeded` 4xx — the dominant failure class on small-NAV accounts.
  async getInstruments(): Promise<T212Instrument[]> {
    const res = await fetch(`${this.baseUrl}/equity/metadata/instruments`, { headers: this.headers });
    if (!res.ok) throw new Error(`T212 instruments: ${res.status}`);
    const data = await res.json() as Array<Record<string, unknown>>;
    return (data ?? []).map((p) => ({
      ticker:           String(p.ticker ?? ''),
      minTradeQuantity: Number(p.minTradeQuantity ?? 0),
      maxOpenQuantity:  Number(p.maxOpenQuantity ?? 0),
      currencyCode:     String(p.currencyCode ?? ''),
      type:             String(p.type ?? ''),
      // T212's public /equity/metadata/instruments doesn't expose per-instrument
      // quantity precision. The real value varies wildly per ticker (LSE GBX names
      // typically 2 dp, some US fractional 3 dp, others 4 dp) and the broker rejects
      // any submission with finer precision than it expects. Until we have a real
      // source, the cache layer defaults this to DEFAULT_PRECISION (currently 2) —
      // coarse enough to cover most LSE GBX names without breaking US fractional too
      // much. Tracked for a proper per-ticker fix.
      precision:        typeof p.precision === 'number' ? p.precision : undefined,
    }));
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
    // Parse each item's broker ticker into the bare identity at the boundary, so consumers
    // read `(symbol, market)` rather than re-deriving it. `ticker` is preserved (terminated
    // orders are matched to Mongo orders by `t212OrderId`, not by ticker). A non-US/LSE form
    // leaves symbol/market undefined fail-soft — the consumer falls back to `ticker`.
    const items = (data.items ?? []).map((item) => {
      const id = tryFromT212(item.order?.ticker ?? '');
      return id
        ? { ...item, order: { ...item.order, symbol: id.symbol, market: id.market } }
        : item;
    });
    return { items, nextPagePath: data.nextPagePath ?? null };
  }
}

/** Parse a broker ticker fail-soft: `(symbol, market)` or `null` for a non-US/LSE form. */
function tryFromT212(ticker: string): TickerIdentity | null {
  try { return adapter.fromT212(ticker); } catch { return null; }
}

export interface T212Instrument {
  ticker:           string;
  minTradeQuantity: number;   // e.g. 0.01 (US fractional), 1 (whole-share), 0.01510719 (some LSE ETFs)
  maxOpenQuantity:  number;
  currencyCode:     string;   // ISO 4217
  type:             string;   // 'STOCK' | 'ETF' | ...
  // Per-instrument max quantity precision T212 will accept. T212's public metadata
  // endpoint does NOT currently expose this — the field is kept on the interface so
  // (a) downstream callers always have a typed `precision` to read, and (b) when
  // T212 (or a future authenticated/private endpoint) starts exposing it, the parser
  // path is in place. Until then it is `undefined` and the cache uses DEFAULT_PRECISION.
  precision?:       number | undefined;
}

// Subset of fields we actually use. T212 returns more (currency, walletImpact, taxes, etc.)
// that we intentionally drop here so the structural type stays small and the tests are easy.
export interface T212HistoryItem {
  order: {
    id:             number;
    status:         string;   // 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED' | 'NEW' | ...
    side:           'BUY' | 'SELL';
    ticker:         string;
    // Bare identity parsed off `ticker` at the boundary (getHistoricalOrders). Absent only
    // for a non-US/LSE form, where consumers fall back to `ticker`.
    symbol?:        string;
    market?:        TickerIdentity['market'];
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
