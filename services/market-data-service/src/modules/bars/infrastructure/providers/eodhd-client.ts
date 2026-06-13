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
import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';
import { log } from '../../../../logger.ts';
import { EodhdCreditLimiter, EodhdDailyLimitError } from './eodhd-credit-limiter.ts';

const EODHD_BASE = 'https://eodhd.com/api';

// Approximate per-endpoint EODHD API-call consumption. EODHD weights heavier endpoints more
// than a single /eod call; the exact weights vary by plan, so these are conservative and the
// limiter's day budget carries headroom. Verify against EODHD's current consumption table.
//
// technical/dividends/splits/news bill like a single /eod call (1); the exchange-metadata
// endpoints (exchangeDetails/exchangesList) are low-volume reference lookups — also 1.
export const EODHD_COST = {
  eod: 1, bulk: 100, screener: 5, fundamentals: 10, realtime: 1,
  technical: 1, dividends: 1, splits: 1, news: 1, exchangeDetails: 1, exchangesList: 1,
} as const;

export type EodhdExchange = 'US' | 'LSE';

// The single suffix parser + the market-aware FB→META rename both live in the adapter now — this
// client no longer carries its own `parseT212Ticker` / `SYMBOL_RENAMES`. The EODHD symbol is built
// from a `TickerIdentity` (the universe build is bare-native); legacy T212-string callers go through
// the `fromT212` thin wrapper below.
const adapter = new Trading212TickerAdapter();

const EODHD_EXCHANGE_BY_MARKET: Record<TickerIdentity['market'], string> = { US: 'US', LSE: 'LSE' };

/**
 * Map a bare `(symbol, market)` identity to an EODHD `SYMBOL.EXCHANGE`. US → `.US`, LSE → `.LSE`.
 * The market-aware rename (FB→META) is applied so the EODHD request uses the canonical symbol.
 */
export function toEodhdSymbolFromIdentity(id: TickerIdentity): string {
  const { symbol, market } = adapter.applyRename(id);
  return `${symbol}.${EODHD_EXCHANGE_BY_MARKET[market]}`;
}

/**
 * Map a T212 ticker to an EODHD `SYMBOL.EXCHANGE`. Thin wrapper over the identity-native mapping for
 * the call sites that still hold a T212 string (corporate-actions, news, technical, quotes, the
 * daily-history backfill). US → `.US`, LSE → `.LSE`. Fail-soft on a non-US/LSE string: defaults to a
 * `.US` listing (preserving the prior parser's default-US behaviour for legacy/oddball tickers) rather
 * than throwing into the call site.
 */
export function toEodhdSymbol(t212Ticker: string): string {
  let id: TickerIdentity;
  try { id = adapter.fromT212(t212Ticker); }
  catch { id = { symbol: t212Ticker.trim(), market: 'US' }; }   // default US, as the old suffix parser did
  return toEodhdSymbolFromIdentity(id);
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

// Build an object holding only the optional string fields EODHD actually sent (non-empty strings),
// each mapped to its output key. Skips absent/empty/non-string values so under
// `exactOptionalPropertyTypes` the result never carries an explicit `undefined` — a consumer's `?.`
// check means "EODHD didn't send it", not "it sent an empty string". Returned typed so spreading it
// keeps each value strictly `string`.
function pickStrings<K extends string>(src: Record<string, unknown>, keyMap: Record<string, K>): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const [srcKey, outKey] of Object.entries(keyMap)) {
    const v = src[srcKey];
    if (typeof v === 'string' && v !== '') out[outKey] = v;
  }
  return out;
}

// Parse an EODHD split ratio string ('2/1', '3/2', '1/4' for a reverse split) into a share-count
// multiplier (numerator / denominator). NaN when the string is missing a finite numerator or a
// non-zero denominator — the caller keeps the raw `ratio` and treats NaN as "don't auto-adjust".
function parseSplitFactor(ratio: string): number {
  const [num, den] = ratio.split('/');
  const n = Number(num);
  const d = Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return NaN;
  return n / d;
}

// ── Response shapes (the subset we read) ──────────────────────────────────────────
export interface EodhdEodRow {
  date: string;            // 'YYYY-MM-DD'
  open: number; high: number; low: number; close: number;
  adjusted_close: number;  // split + dividend adjusted (total-return)
  volume: number;
}
export interface EodhdBulkRow extends EodhdEodRow { code: string; }

export interface EodhdRealTimeRow {
  code: string;        // the SYMBOL.EXCHANGE as requested (maps back to the T212 ticker)
  close: number;       // last trade price, in the listing's native unit (LSE = pence — scale at the boundary)
  timestampMs: number; // quote time (UTC ms); Date.now() when EODHD returns 'NA'
}

export interface EodhdScreenerRow {
  code: string;
  name: string;
  exchange: string;        // e.g. 'US' | 'LSE'
  marketCap: number;       // in the listing currency (FX-normalised by the caller)
  currency?: string;       // currency_symbol, when present
  sector?: string;         // GICS-ish sector from the screener — sourced for free (no Yahoo)
}

// One point on an EODHD Technical-API series (RSI/MACD/ADX/ATR/Bollinger/beta/volatility/…).
// EODHD returns one object per date whose value keys depend on the requested `function`; we keep
// the raw numeric values map so a caller picks the keys it asked for (e.g. `macd`/`signal`/
// `divergence` for MACD, or `value` for a single-output function) without this client owning the
// per-indicator schema. Display/supplement only — factors stay computed in quant-core.
export interface EodhdTechnicalPoint {
  date: string;                         // 'YYYY-MM-DD' observation date
  values: Record<string, number>;       // indicator outputs for that date (finite numbers only)
}

// One cash-dividend event. `value` is per-share in the listing's native unit (LSE = pence); the
// caller scales at the boundary like prices. `date` is the ex-dividend date (the point-in-time
// instant the market prices it in) — the field the backfillable Value dividend-yield input keys on.
export interface EodhdDividendEvent {
  date: string;                         // 'YYYY-MM-DD' ex-dividend date
  value: number;                        // gross dividend per share (native unit)
  currency?: string;                    // EODHD-declared currency, when present
  declarationDate?: string;             // 'YYYY-MM-DD', when present
  recordDate?: string;                  // 'YYYY-MM-DD', when present
  paymentDate?: string;                 // 'YYYY-MM-DD', when present
}

// One stock-split event. `ratio` is the raw EODHD string ('2/1', '3/2', …); `factor` is that
// parsed into a multiplier on the share count (2/1 → 2, 1/4 reverse-split → 0.25), or NaN if the
// ratio string is unparseable. Corporate-actions correctness for adjusted prices.
export interface EodhdSplitEvent {
  date: string;                         // 'YYYY-MM-DD' split-effective date
  ratio: string;                        // raw EODHD ratio, e.g. '2/1'
  factor: number;                       // ratio parsed to a share-count multiplier (NaN if unparseable)
}

// One news article for a symbol. Body text is dropped (only title/link/date/symbols/tags kept);
// `sentiment` is present only when the EODHD tier returns it (it is on this plan's News add-on but
// callers must treat it as optional). Powers the Overview "Recent Events" panel + narrative context.
export interface EodhdNewsArticle {
  date: string;                         // ISO-8601 publish timestamp as returned by EODHD
  title: string;
  link: string;
  symbols: string[];                    // related EODHD symbols (may be empty)
  tags: string[];                       // EODHD topic tags (may be empty)
  sentiment?: { polarity: number; neg: number; neu: number; pos: number };  // only if the tier returns it
}

// Exchange metadata + the holiday schedule that backs the live EODHD holiday provider (replacing
// the static US fallback in @trader/shared-calendar). `tradingHours`/`holidays` are present only on
// the Exchange-Details endpoint (the Exchanges-List rows carry just the identity fields).
export interface EodhdExchangeDetails {
  name: string;
  code: string;                         // EODHD exchange code, e.g. 'US' | 'LSE'
  operatingMIC?: string;
  country?: string;
  currency?: string;
  countryISO2?: string;
  countryISO3?: string;
  tradingHours?: {
    open?: string;                      // 'HH:MM:SS' local
    close?: string;                     // 'HH:MM:SS' local
    workingDays?: string;               // e.g. 'Mon,Tue,Wed,Thu,Fri'
    openUTC?: string;
    closeUTC?: string;
  };
  holidays: EodhdExchangeHoliday[];     // [] when absent (degrade-safe for the calendar provider)
}

// One market holiday from Exchange-Details. `type` distinguishes a full close from an early close;
// EODHD spells it variably, so it is passed through verbatim for the calendar provider to interpret.
export interface EodhdExchangeHoliday {
  date: string;                         // 'YYYY-MM-DD'
  name: string;
  type?: string;                        // e.g. 'holiday' | 'half-day' (verbatim from EODHD)
}

// One row of the Exchanges-List enumeration (identity only — no hours/holidays here).
export interface EodhdExchangeListItem {
  name: string;
  code: string;                         // EODHD exchange code (feed Exchange-Details by this)
  operatingMIC?: string;
  country?: string;
  currency?: string;
  countryISO2?: string;
  countryISO3?: string;
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

  /**
   * Real-time (delayed) last-trade prices for multiple `SYMBOL.EXCHANGE`s. EODHD batches via the
   * `s=` param (first symbol in the path, the rest comma-separated); each symbol counts as one
   * call against the budget. Returns last `close` (NOT a bid/ask book — EODHD real-time has no
   * book) tagged with the symbol so the caller maps back to its T212 ticker. Empty on budget
   * exhaustion / not-entitled / error (degrades to synthetic upstream). Requires the EODHD
   * real-time add-on; on a plan without it the endpoint 4xxs and this returns [].
   */
  async realTimeQuotes(eodhdSymbols: string[]): Promise<EodhdRealTimeRow[]> {
    const out: EodhdRealTimeRow[] = [];
    const BATCH = 20;
    for (let i = 0; i < eodhdSymbols.length; i += BATCH) {
      const batch = eodhdSymbols.slice(i, i + BATCH);
      const first = batch[0];
      if (!first) continue;
      const rest = batch.slice(1);
      const query: Record<string, string> = rest.length ? { s: rest.join(',') } : {};
      const body = await this.get<unknown>(`/real-time/${first}`, query, batch.length * EODHD_COST.realtime);
      if (!body) continue;
      const rows = Array.isArray(body) ? body : [body];
      for (const raw of rows as Array<Record<string, unknown>>) {
        const code = String(raw.code ?? '');
        const close = numOr(raw.close, NaN);
        const tsSec = numOr(raw.timestamp, NaN);
        if (code === '' || !Number.isFinite(close) || close <= 0) continue;
        out.push({ code, close, timestampMs: Number.isFinite(tsSec) ? tsSec * 1000 : Date.now() });
      }
    }
    return out;
  }

  /**
   * Technical-API series for one EODHD `SYMBOL.EXCHANGE`. `func` is the EODHD `function`
   * (`rsi`/`macd`/`adx`/`atr`/`bbands`/`beta`/`volatility`/`stochastic`/…); `params` are passed
   * through verbatim (e.g. `{ period: '14' }`, `{ from, to }`). Each date's value keys depend on
   * the function — we keep them as a `Record<string, number>` (finite values only) so the caller
   * reads the keys it requested without this client owning a per-indicator schema. **Display/
   * supplement only** — factors stay computed in quant-core for live/replay parity. Empty on
   * budget exhaustion / not-entitled / error.
   */
  async technical(eodhdSymbol: string, func: string, params: Record<string, string> = {}): Promise<EodhdTechnicalPoint[]> {
    const rows = await this.get<Array<Record<string, unknown>>>(`/technical/${eodhdSymbol}`, {
      ...params, function: func,
    }, EODHD_COST.technical);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const values: Record<string, number> = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === 'date') continue;
          const n = Number(v);
          if (Number.isFinite(n)) values[k] = n;
        }
        return { date: String(r.date ?? ''), values };
      })
      .filter((p) => p.date !== '' && Object.keys(p.values).length > 0);
  }

  /**
   * Cash-dividend history for one EODHD `SYMBOL.EXCHANGE` between two 'YYYY-MM-DD' bounds
   * (inclusive; both optional — omit for the full available history). `value` is per-share in the
   * native unit (LSE = pence — the caller scales at the boundary). Point-in-time by ex-dividend
   * date — the backfillable Value dividend-yield input. Empty on budget exhaustion / error.
   */
  async dividends(eodhdSymbol: string, fromIso?: string, toIso?: string): Promise<EodhdDividendEvent[]> {
    const query: Record<string, string> = {};
    if (fromIso) query.from = fromIso;
    if (toIso) query.to = toIso;
    const rows = await this.get<Array<Record<string, unknown>>>(`/div/${eodhdSymbol}`, query, EODHD_COST.dividends);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        date:  String(r.date ?? ''),
        value: numOr(r.value, NaN),
        ...pickStrings(r, {
          currency: 'currency', declarationDate: 'declarationDate', recordDate: 'recordDate', paymentDate: 'paymentDate',
        }),
      }))
      .filter((d): d is EodhdDividendEvent => d.date !== '' && Number.isFinite(d.value));
  }

  /**
   * Stock-split history for one EODHD `SYMBOL.EXCHANGE` between two 'YYYY-MM-DD' bounds (inclusive;
   * both optional). `ratio` is kept raw ('2/1'); `factor` is it parsed to a share-count multiplier
   * (NaN if unparseable — the caller treats that as "don't auto-adjust"). Corporate-actions
   * correctness for adjusted prices. Empty on budget exhaustion / error.
   */
  async splits(eodhdSymbol: string, fromIso?: string, toIso?: string): Promise<EodhdSplitEvent[]> {
    const query: Record<string, string> = {};
    if (fromIso) query.from = fromIso;
    if (toIso) query.to = toIso;
    const rows = await this.get<Array<Record<string, unknown>>>(`/splits/${eodhdSymbol}`, query, EODHD_COST.splits);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const ratio = String(r.split ?? r.ratio ?? '');
        return { date: String(r.date ?? ''), ratio, factor: parseSplitFactor(ratio) };
      })
      .filter((s) => s.date !== '' && s.ratio !== '');
  }

  /**
   * Recent news articles for one EODHD `SYMBOL.EXCHANGE`. `limit`/`offset` paginate (EODHD caps a
   * page at 1000; we clamp to a sane default). `from`/`to` ('YYYY-MM-DD') narrow the window. Body
   * text is dropped (title/link/date/symbols/tags only). `sentiment` is surfaced only when the
   * tier returns it. Powers the Overview "Recent Events" panel + narrative/"Why?" context. Empty
   * on budget exhaustion / error.
   */
  async news(
    eodhdSymbol: string,
    opts: { limit?: number; offset?: number; from?: string; to?: string } = {},
  ): Promise<EodhdNewsArticle[]> {
    const query: Record<string, string> = {
      s: eodhdSymbol,
      limit: String(Math.max(1, Math.min(1000, opts.limit ?? 50))),
      offset: String(Math.max(0, opts.offset ?? 0)),
    };
    if (opts.from) query.from = opts.from;
    if (opts.to) query.to = opts.to;
    const rows = await this.get<Array<Record<string, unknown>>>('/news', query, EODHD_COST.news);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => {
        const s = r.sentiment as Record<string, unknown> | undefined;
        const sentiment = s && typeof s === 'object'
          ? { polarity: numOr(s.polarity, 0), neg: numOr(s.neg, 0), neu: numOr(s.neu, 0), pos: numOr(s.pos, 0) }
          : undefined;
        return {
          date:    String(r.date ?? ''),
          title:   String(r.title ?? ''),
          link:    String(r.link ?? ''),
          symbols: Array.isArray(r.symbols) ? r.symbols.map((x) => String(x)) : [],
          tags:    Array.isArray(r.tags) ? r.tags.map((x) => String(x)) : [],
          ...(sentiment ? { sentiment } : {}),
        };
      })
      .filter((a) => a.title !== '' && a.date !== '');
  }

  /**
   * Exchange metadata + holiday schedule for one EODHD exchange `code` (e.g. 'US', 'LSE'). Backs
   * the live EODHD holiday provider that replaces the static US fallback in @trader/shared-calendar.
   * Returns null on budget exhaustion / error (distinct from "loaded, no holidays" — the calendar
   * provider must not mistake an outage for a holiday-free year). `holidays` defaults to [].
   */
  async exchangeDetails(code: string): Promise<EodhdExchangeDetails | null> {
    const body = await this.get<Record<string, unknown>>(`/exchange-details/${code}`, {}, EODHD_COST.exchangeDetails);
    if (!body || typeof body !== 'object') return null;
    const th = body.TradingHours as Record<string, unknown> | undefined;
    const tradingHours = th && typeof th === 'object'
      ? pickStrings(th, { Open: 'open', Close: 'close', WorkingDays: 'workingDays', OpenUTC: 'openUTC', CloseUTC: 'closeUTC' })
      : undefined;
    // EODHD returns `ExchangeHolidays` as an object keyed by an opaque id; flatten to a list.
    const rawHolidays = body.ExchangeHolidays;
    const holidayRows = rawHolidays && typeof rawHolidays === 'object'
      ? Object.values(rawHolidays as Record<string, unknown>)
      : Array.isArray(rawHolidays) ? rawHolidays : [];
    const holidays: EodhdExchangeHoliday[] = holidayRows
      .map((h) => h as Record<string, unknown>)
      .map((h) => ({
        date: String(h.Date ?? h.date ?? ''),
        name: String(h.Holiday ?? h.name ?? ''),
        ...pickStrings(h, { Type: 'type' }),
      }))
      .filter((h) => h.date !== '');
    return {
      name: String(body.Name ?? ''),
      code: String(body.Code ?? code),
      ...pickStrings(body, {
        OperatingMIC: 'operatingMIC', Country: 'country', Currency: 'currency', CountryISO2: 'countryISO2', CountryISO3: 'countryISO3',
      }),
      ...(tradingHours && Object.keys(tradingHours).length > 0 ? { tradingHours } : {}),
      holidays,
    };
  }

  /**
   * Enumerate every EODHD exchange (identity only — no hours/holidays; feed each `code` to
   * `exchangeDetails`). Backs the Exchange-Details lookup + a universe/scanner cross-check. Empty
   * on budget exhaustion / error.
   */
  async exchangesList(): Promise<EodhdExchangeListItem[]> {
    const rows = await this.get<Array<Record<string, unknown>>>('/exchanges-list/', {}, EODHD_COST.exchangesList);
    if (!Array.isArray(rows)) return [];
    return rows
      .map((r) => ({
        name: String(r.Name ?? ''),
        code: String(r.Code ?? ''),
        ...pickStrings(r, {
          OperatingMIC: 'operatingMIC', Country: 'country', Currency: 'currency', CountryISO2: 'countryISO2', CountryISO3: 'countryISO3',
        }),
      }))
      .filter((e) => e.code !== '');
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
