// EODHD low-level client — the platform's daily/EOD + market-scanner upstream.
//
// EODHD is deliberately NOT a MarketDataProvider: that interface is the live 5m-intraday
// contract (fetchRecent returns a window of 5m bars), which EODHD does not serve well. EODHD's
// jobs here are (1) the market-cap SCREENER that scans the whole US+LSE market to seed the
// single active universe, (2) the BULK end-of-day feed (one request per exchange per day), and
// (3) multi-year DAILY history for the persisted `interval:'daily'` series. Intraday stays on
// TwelveData. This client owns everything EODHD-specific: symbol mapping, currency/pence
// normalisation, the shared call-budget limiter, and request/parse.

import type { OHLCVBar, Currency } from '@trader/shared-types';
import { log } from '../../../../logger.ts';
import { EodhdCreditLimiter, EodhdDailyLimitError } from './eodhd-credit-limiter.ts';

const EODHD_BASE = 'https://eodhd.com/api';

// Approximate per-endpoint EODHD API-call consumption. EODHD weights heavier endpoints more
// than a single /eod call; the exact weights vary by plan, so these are conservative and the
// limiter's day budget carries headroom. Verify against EODHD's current consumption table.
export const EODHD_COST = { eod: 1, bulk: 100, screener: 5, fundamentals: 10 } as const;

// Legacy-rename overrides — mirror twelvedata/yahoo so the curated/scanned universe resolves
// identically across providers (T212 keeps the pre-rebrand symbol; EODHD wants the new one).
const SYMBOL_RENAMES: Record<string, string> = { FB: 'META' };

export type EodhdExchange = 'US' | 'LSE';

/** Strip ONLY Trading212 synthetic suffixes: d = fractional, l = LSE/CFD. */
function normalizeBaseSymbol(raw: string): string { return raw.replace(/[dl]$/, ''); }

export function parseT212Ticker(t212Ticker: string): { symbol: string; exchange: 'US' | 'UK' | null } {
  const parts = t212Ticker.split('_');
  const rawSymbol = parts[0] ?? t212Ticker;
  const symbol = normalizeBaseSymbol(rawSymbol);
  let exchange: 'US' | 'UK' | null = null;
  if (parts.length >= 3 && parts[1] === 'US') exchange = 'US';            // SYMBOL_US_EQ
  else if (parts.length === 2 && parts[1] === 'EQ' && /l$/.test(rawSymbol)) exchange = 'UK';   // SYMBOLl_EQ
  return { symbol, exchange };
}

/** Map a T212 ticker to an EODHD `SYMBOL.EXCHANGE`. US → `.US`, LSE → `.LSE`. */
export function toEodhdSymbol(t212Ticker: string): string {
  const { symbol, exchange } = parseT212Ticker(t212Ticker);
  const resolved = SYMBOL_RENAMES[symbol] ?? symbol;
  return exchange === 'UK' ? `${resolved}.LSE` : `${resolved}.US`;        // default US (curated universe is US+LSE)
}

// EODHD's /eod and /eod-bulk-last-day responses carry no per-bar currency, so it is inferred
// from the exchange: US → USD; LSE quotes common stock in pence (GBX) → divide by 100, tag GBP.
// Same boundary policy as the 5m providers (pence is killed here; downstream sees GBP/USD only).
// USD/GBP-denominated LSE ETFs would be mis-scaled, but the >=£5B common-stock universe quotes
// in pence — acceptable + noted.
export function eodhdCurrencyForExchange(ex: EodhdExchange | string): { currency: Currency; priceScale: number } {
  return ex === 'LSE' ? { currency: 'GBP', priceScale: 0.01 } : { currency: 'USD', priceScale: 1 };
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── Response shapes (the subset we read) ──────────────────────────────────────────
export interface EodhdEodRow {
  date: string;            // 'YYYY-MM-DD'
  open: number; high: number; low: number; close: number;
  adjusted_close: number;  // split + dividend adjusted (total-return)
  volume: number;
}
export interface EodhdBulkRow extends EodhdEodRow { code: string; }

export interface EodhdScreenerRow {
  code: string;
  name: string;
  exchange: string;        // e.g. 'US' | 'LSE'
  marketCap: number;       // in the listing currency (FX-normalised by the caller)
  currency?: string;       // currency_symbol, when present
  sector?: string;         // GICS-ish sector from the screener — sourced for free (no Yahoo)
}

export interface EodhdClientOptions {
  apiKey: string;
  callsPerMinute?: number;
  dailyCallLimit?: number;
}

export class EodhdClient {
  private readonly apiKey: string;
  private readonly limiter: EodhdCreditLimiter;
  private dailyLimitLoggedDay: number | null = null;

  constructor(opts: EodhdClientOptions) {
    this.apiKey = opts.apiKey;
    this.limiter = new EodhdCreditLimiter(opts.callsPerMinute ?? 1000, opts.dailyCallLimit ?? 90_000);
  }

  get callsUsedToday(): number { return this.limiter.used; }
  get dailyCallLimit(): number { return this.limiter.dailyLimit; }

  private logDailyLimitOnce(): void {
    const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    if (this.dailyLimitLoggedDay === today) return;
    this.dailyLimitLoggedDay = today;
    log.warn(`[eodhd] daily call budget (${this.limiter.dailyLimit}) exhausted — skipping further requests until UTC midnight`);
  }

  // Single GET against EODHD. Returns null (not throw) on budget exhaustion / 429 / 5xx /
  // network error so callers degrade to empty. The query string (carrying api_token) is never
  // logged; only the path is.
  private async get<T>(path: string, query: Record<string, string>, cost: number): Promise<T | null> {
    try {
      await this.limiter.acquire(cost);
    } catch (err) {
      if (err instanceof EodhdDailyLimitError) { this.logDailyLimitOnce(); return null; }
      throw err;
    }
    const qs = new URLSearchParams({ ...query, api_token: this.apiKey, fmt: 'json' }).toString();
    try {
      const res = await fetch(`${EODHD_BASE}${path}?${qs}`, { headers: { Accept: 'application/json' } });
      if (res.status === 429) { log.warn(`[eodhd] HTTP 429 on ${path} — throttled`); return null; }
      if (!res.ok) { log.warn(`[eodhd] HTTP ${res.status} on ${path}`); return null; }
      return (await res.json()) as T;
    } catch (err) {
      log.warn(`[eodhd] request failed on ${path}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * One screener page (EODHD caps `limit` at 100; caller paginates via `offset`). `filters`
   * is EODHD's JSON-array-of-arrays, e.g. [["market_capitalization",">",6e9],["exchange","=","us"]].
   */
  async screener(filters: unknown[], sort: string, limit: number, offset: number): Promise<EodhdScreenerRow[]> {
    const body = await this.get<{ data?: Array<Record<string, unknown>> }>('/screener', {
      filters: JSON.stringify(filters),
      sort,
      limit: String(Math.max(1, Math.min(100, limit))),
      offset: String(Math.max(0, offset)),
    }, EODHD_COST.screener);
    if (!body?.data) return [];
    return body.data
      .map((d) => ({
        code:      String(d.code ?? ''),
        name:      String(d.name ?? ''),
        exchange:  String(d.exchange ?? ''),
        marketCap: numOr(d.market_capitalization, 0),
        ...(typeof d.currency_symbol === 'string' ? { currency: d.currency_symbol } : {}),
        ...(typeof d.sector === 'string' && d.sector ? { sector: d.sector } : {}),
      }))
      .filter((r) => r.code !== '');
  }

  /** Whole-exchange end-of-day in one request. `date` omitted → the latest trading day. */
  async bulkLastDay(exchange: EodhdExchange, date?: string): Promise<EodhdBulkRow[]> {
    const query: Record<string, string> = {};
    if (date) query.date = date;
    const rows = await this.get<Array<Record<string, unknown>>>(`/eod-bulk-last-day/${exchange}`, query, EODHD_COST.bulk);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        code:           String(r.code ?? ''),
        date:           String(r.date ?? ''),
        open:           numOr(r.open, NaN),
        high:           numOr(r.high, NaN),
        low:            numOr(r.low, NaN),
        close:          numOr(r.close, NaN),
        adjusted_close: numOr(r.adjusted_close, NaN),
        volume:         numOr(r.volume, 0),
      }))
      .filter((r) => r.code !== '' && Number.isFinite(r.close));
  }

  /** Daily history for one EODHD `SYMBOL.EXCHANGE` between two 'YYYY-MM-DD' bounds (inclusive). */
  async eodHistory(eodhdSymbol: string, fromIso: string, toIso: string): Promise<EodhdEodRow[]> {
    const rows = await this.get<Array<Record<string, unknown>>>(`/eod/${eodhdSymbol}`, {
      from: fromIso, to: toIso, period: 'd', order: 'a',
    }, EODHD_COST.eod);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        date:           String(r.date ?? ''),
        open:           numOr(r.open, NaN),
        high:           numOr(r.high, NaN),
        low:            numOr(r.low, NaN),
        close:          numOr(r.close, NaN),
        adjusted_close: numOr(r.adjusted_close, NaN),
        volume:         numOr(r.volume, 0),
      }))
      .filter((r) => r.date !== '' && Number.isFinite(r.close));
  }
}

// ── Bar construction ────────────────────────────────────────────────────────────
// Build a bi-temporal-ready daily OHLCVBar from an EODHD EOD row. `close` is the total-return
// (adjusted) close so momentum/vol see split+dividend-adjusted prices; rawClose/adjustedClose/
// adjustmentFactor are populated and OHLC is scaled by the same factor so the candle stays
// internally consistent. Pence (LSE) is divided out via priceScale. The most-recent bar's
// adjusted == raw, so order-sizing off the latest close is unaffected by the adjustment.
export function eodRowToDailyBar(ticker: string, r: EodhdEodRow, currency: Currency, priceScale: number): OHLCVBar | null {
  const obsMs = Date.parse(`${r.date}T00:00:00Z`);
  if (!Number.isFinite(obsMs)) return null;
  const rawClose = r.close;
  const adjClose = Number.isFinite(r.adjusted_close) && r.adjusted_close > 0 ? r.adjusted_close : rawClose;
  if (!Number.isFinite(adjClose) || adjClose <= 0) return null;
  const factor = Number.isFinite(rawClose) && rawClose > 0 ? adjClose / rawClose : 1;
  return {
    ticker,
    observation_ts: obsMs,
    timestamp:      obsMs,
    interval:       'daily',
    currency,
    open:   numOr(r.open, rawClose) * factor * priceScale,
    high:   numOr(r.high, rawClose) * factor * priceScale,
    low:    numOr(r.low,  rawClose) * factor * priceScale,
    close:  adjClose * priceScale,
    volume: numOr(r.volume, 0),
    rawClose:         rawClose * priceScale,
    adjustedClose:    adjClose * priceScale,
    adjustmentFactor: factor,
  };
}

// ── Module-configured singleton (mirrors t212-client's configure pattern) ──────────
let _client: EodhdClient | null = null;

export function configureEodhdClient(opts: EodhdClientOptions): void { _client = new EodhdClient(opts); }

export function getEodhdClient(): EodhdClient {
  if (!_client) {
    // Lazy default from env (tests, or a call before configure at boot).
    _client = new EodhdClient({
      apiKey:         process.env.EODHD_API_KEY ?? '',
      callsPerMinute: Number(process.env.EODHD_CALLS_PER_MIN ?? 1000),
      dailyCallLimit: Number(process.env.EODHD_DAILY_CALL_LIMIT ?? 90_000),
    });
  }
  return _client;
}

/** Test seam: inject a client (or reset to null so the next getEodhdClient() rebuilds). */
export function _setEodhdClientForTest(c: EodhdClient | null): void { _client = c; }

/**
 * Multi-year daily history for a T212 ticker via EODHD. Mirrors `fetchYahooDailyHistory`'s
 * shape so the daily-history backfill can dispatch on DAILY_HISTORY_PROVIDER with no other
 * changes. Oldest-first, `interval:'daily'`, pence-normalised, total-return close.
 */
export async function fetchEodhdDailyHistory(t212Ticker: string, startMs: number, endMs: number): Promise<OHLCVBar[]> {
  if (endMs <= startMs) return [];
  const eodhdSymbol = toEodhdSymbol(t212Ticker);
  const exchange: EodhdExchange = eodhdSymbol.endsWith('.LSE') ? 'LSE' : 'US';
  const { currency, priceScale } = eodhdCurrencyForExchange(exchange);
  const fromIso = new Date(startMs).toISOString().slice(0, 10);
  const toIso = new Date(endMs).toISOString().slice(0, 10);
  const rows = await getEodhdClient().eodHistory(eodhdSymbol, fromIso, toIso);
  const bars = rows
    .map((r) => eodRowToDailyBar(t212Ticker, r, currency, priceScale))
    .filter((b): b is OHLCVBar => b !== null);
  bars.sort((a, b) => a.observation_ts - b.observation_ts);
  return bars;
}
