// TwelveData low-level client — symbol mapping (T212 → TwelveData), currency
// normalisation, free-tier credit rate-limiting, and the /time_series fetch + parse.
//
// Separated from twelvedata-provider.ts the same way yahoo-client is separated from
// yahoo-provider: this module owns everything upstream-specific (request shape, credit
// budget, blacklist) so the provider stays a thin MarketDataProvider adapter.
//
// FREE-TIER BUDGET. The Basic (free) plan allows 8 API credits/minute and 800/day; one
// /time_series request for a single symbol costs 1 credit. At a ~200-ticker universe a
// full poll is therefore ~200 credits and ~25 minutes (8/min) — which is why the provider
// advertises only a 24h poll cadence (intraday is not affordable on the free tier at this
// universe size). CreditLimiter enforces both ceilings; once the daily budget is spent,
// every further request degrades to "return nothing" so callers (poll, heal, backfill)
// skip cleanly rather than throwing.

import { setTimeout as sleep } from 'node:timers/promises';
import type { OHLCVBar, BarInterval, Currency } from '@trader/shared-types';
import { Trading212TickerAdapter, type TickerIdentity } from '@trader/ticker-identity';
import { log } from '../../../../logger.ts';

const TWELVEDATA_BASE = 'https://api.twelvedata.com';

// LSE market identifier code. TwelveData disambiguates a symbol across listings via
// `mic_code` (preferred over the looser `exchange` param); XLON is the London Stock
// Exchange. US symbols are disambiguated with `country=United States` instead, because a
// single US name can sit on NYSE or NASDAQ and the T212 ticker doesn't tell us which.
const MIC_LSE = 'XLON';

// The single suffix parser + the market-aware FB→META rename both live in the adapter now — this
// client no longer carries its own `parseT212Ticker` / `SYMBOL_RENAMES`. The request params are
// derived from a `TickerIdentity` (the universe build is bare-native); the per-ticker fetch path
// builds the identity once via the `fromT212` thin wrapper.
const adapter = new Trading212TickerAdapter();

export interface TwelveDataClientOptions {
  apiKey: string;
  /** Credits per minute the plan allows. Free Basic = 8. */
  creditsPerMinute?: number;
  /** Credits per UTC day the plan allows. Free Basic = 800. */
  dailyCreditLimit?: number;
}

// ── Currency normalisation ──────────────────────────────────────────────────────
// Pence ('GBp' / 'GBX' on TwelveData's LSE listings) is killed at the boundary exactly as
// in yahoo-client.normaliseYahooCurrency: divide by 100, tag GBP. After this point in the
// pipeline currency is strictly 'GBP' or 'USD' — pence does not exist downstream.
//
// Returns the normalised currency (or null when unrecognised) and the scale factor to
// multiply every price field by (1.0 for GBP/USD, 0.01 for pence).
export function normaliseTwelveDataCurrency(raw: string | undefined): {
  currency: Currency | null;
  priceScale: number;
} {
  if (!raw) return { currency: null, priceScale: 1 };
  // Pence FIRST, case-sensitively: 'GBp' uppercases to 'GBP' and would otherwise be
  // misread as already-pounds. 'GBX' (alternate label) is matched case-insensitively.
  if (raw === 'GBp' || raw.toUpperCase() === 'GBX') return { currency: 'GBP', priceScale: 0.01 };
  const c = raw.toUpperCase();
  if (c === 'GBP') return { currency: 'GBP', priceScale: 1 };
  if (c === 'USD') return { currency: 'USD', priceScale: 1 };
  return { currency: null, priceScale: 1 };
}

// ── Symbol mapping ──────────────────────────────────────────────────────────────
interface TwelveDataSymbol {
  symbol: string;
  micCode?: string;
  country?: string;
}

/**
 * Map a bare `(symbol, market)` identity to the TwelveData request parameters that pin the right
 * listing: LSE → `mic_code=XLON`, US → `country=United States`. The market-aware rename (FB→META) is
 * applied so TwelveData (which only knows the post-rebrand symbol) resolves.
 */
export function toTwelveDataSymbolFromIdentity(id: TickerIdentity): TwelveDataSymbol {
  const { symbol, market } = adapter.applyRename(id);
  return market === 'LSE'
    ? { symbol, micCode: MIC_LSE }
    : { symbol, country: 'United States' };
}

/**
 * Map a T212 ticker to the TwelveData request parameters. Thin wrapper over the identity-native
 * mapping for the per-ticker fetch path (which holds a T212 string). Returns `null` when the string
 * is not a parseable US/LSE equity (an `OTHER`-bucket / malformed ticker the adapter rejects): the
 * old fail-soft passthrough forwarded such a string verbatim to `/time_series`, which TwelveData
 * answered with a 404 — a guaranteed wasted credit on every poll. Returning `null` lets the caller
 * hard-skip the ticker (blacklist it) instead of paying for a request that can only fail.
 */
export function toTwelveDataSymbol(t212Ticker: string): TwelveDataSymbol | null {
  try { return toTwelveDataSymbolFromIdentity(adapter.fromT212(t212Ticker)); }
  catch { return null; }
}

// ── Credit rate-limiter ─────────────────────────────────────────────────────────
export class TwelveDataDailyLimitError extends Error {
  constructor(public readonly used: number, public readonly limit: number) {
    super(`TwelveData daily credit budget exhausted (${used}/${limit})`);
    this.name = 'TwelveDataDailyLimitError';
  }
}

function startOfUtcDay(atMs = Date.now()): number {
  const d = new Date(atMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

class CreditLimiter {
  private window: number[] = [];          // request timestamps within the last 60s
  private dayUsed = 0;
  private dayStart = startOfUtcDay();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly perMinute: number, private readonly perDay: number) {}

  get used(): number { this.rollover(); return this.dayUsed; }
  get dailyLimit(): number { return this.perDay; }

  private rollover(): void {
    const ds = startOfUtcDay();
    if (ds !== this.dayStart) { this.dayStart = ds; this.dayUsed = 0; }
  }

  // Serialised credit acquisition. Each call waits for a free per-minute slot, then
  // accounts one credit. Concurrent callers (backfill runs several tickers in parallel)
  // queue on `tail` so the window/day counters mutate atomically between awaits. Throws
  // TwelveDataDailyLimitError when the day budget is spent — we fail fast rather than
  // sleeping toward a budget that is already gone.
  async acquire(): Promise<void> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => { release = r; });
    await prev;
    try {
      this.rollover();
      if (this.dayUsed >= this.perDay) throw new TwelveDataDailyLimitError(this.dayUsed, this.perDay);
      for (;;) {
        const now = Date.now();
        this.window = this.window.filter((t) => now - t < 60_000);
        if (this.window.length < this.perMinute) break;
        const oldest = this.window[0]!;
        await sleep(60_000 - (now - oldest) + 50);     // +50ms slop so the slot has truly expired
      }
      this.window.push(Date.now());
      this.dayUsed++;
    } finally {
      release();
    }
  }
}

// ── Time-series fetch + parse ─────────────────────────────────────────────────────
interface TdTimeSeriesValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
interface TdTimeSeriesResponse {
  meta?: { symbol?: string; currency?: string; interval?: string; exchange?: string; mic_code?: string };
  values?: TdTimeSeriesValue[];
  status?: 'ok' | 'error';
  code?: number;
  message?: string;
}

function numOr(s: string | undefined, fallback: number): number {
  if (s === undefined) return fallback;
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

// Parse TwelveData's 'YYYY-MM-DD HH:MM:SS' (intraday) or 'YYYY-MM-DD' (daily) datetime.
// We request timezone=UTC so these are UTC wall-clock strings → reshape to ISO + 'Z'.
function parseTdDateTime(s: string): number {
  const iso = s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

// Format a Unix-ms instant as TwelveData's 'YYYY-MM-DD HH:MM:SS' in UTC (paired with
// timezone=UTC on the request so start/end_date are interpreted as UTC).
function toTdDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export class TwelveDataClient {
  private readonly apiKey: string;
  private readonly limiter: CreditLimiter;
  // Symbols TwelveData reports as "not found" — cached so we stop spending credits re-asking.
  private readonly unsupported = new Set<string>();
  private dailyLimitLoggedDay: number | null = null;

  constructor(opts: TwelveDataClientOptions) {
    this.apiKey = opts.apiKey;
    this.limiter = new CreditLimiter(opts.creditsPerMinute ?? 8, opts.dailyCreditLimit ?? 800);
  }

  get creditsUsedToday(): number { return this.limiter.used; }
  get dailyCreditLimit(): number { return this.limiter.dailyLimit; }

  /** 5m bars in [startMs, endMs]. Oldest-first, 5m-tagged, currency-normalised. */
  async fetch5mBars(ticker: string, startMs: number, endMs: number): Promise<OHLCVBar[]> {
    return this.requestTimeSeries(ticker, '5m', '5min', {
      start_date: toTdDateTime(startMs),
      end_date:   toTdDateTime(endMs),
      outputsize: '5000',                              // max per request ≈ 64 trading days of 5m
    });
  }

  /** Last `count` daily bars (universe liquidity ranking + latest snapshot). Oldest-first. */
  async fetchDailyBars(ticker: string, count: number): Promise<OHLCVBar[]> {
    return this.requestTimeSeries(ticker, 'daily', '1day', {
      outputsize: String(Math.max(1, Math.min(5000, count))),
    });
  }

  private logDailyLimitOnce(): void {
    const today = startOfUtcDay();
    if (this.dailyLimitLoggedDay === today) return;
    this.dailyLimitLoggedDay = today;
    log.warn(`[twelvedata] daily credit budget (${this.limiter.dailyLimit}) exhausted — skipping further upstream requests until UTC midnight`);
  }

  // Single GET against the TwelveData REST API. Returns the parsed body plus the HTTP
  // status so the caller can distinguish a hard not-available (HTTP 404) from a transient
  // throttle/outage and blacklist accordingly. `httpStatus` is undefined only when the
  // request never reached a response (daily budget exhausted, network error). TwelveData
  // answers an unentitled/missing symbol with HTTP 404 AND a `status:"error"` JSON body
  // (e.g. the free-tier "available starting with the Grow or Venture plan" wall), so the
  // body is parsed even on a non-OK status — both signals feed the blacklist decision
  // upstream. `ticker` is logged on every failure (the query string, which carries the
  // apikey, is never logged); without it a 404 line is anonymous and the offending name can
  // only be found by elimination.
  private async get<T>(
    path: string,
    query: Record<string, string>,
    ticker: string,
  ): Promise<{ body: T | null; httpStatus?: number }> {
    try {
      await this.limiter.acquire();
    } catch (err) {
      if (err instanceof TwelveDataDailyLimitError) { this.logDailyLimitOnce(); return { body: null }; }
      throw err;
    }
    const qs = new URLSearchParams({ ...query, apikey: this.apiKey }).toString();
    try {
      const res = await fetch(`${TWELVEDATA_BASE}${path}?${qs}`, { headers: { Accept: 'application/json' } });
      if (res.status === 429) {
        log.warn(`[twelvedata] HTTP 429 on ${path} for ${ticker} — minute/credit throttle`);
        return { body: null, httpStatus: 429 };
      }
      // Parse the JSON body regardless of HTTP status — TwelveData returns a descriptive
      // `status:"error"` body alongside a 404/4xx (the entitlement/not-found message the
      // blacklist keys off). Tolerate a non-JSON error body (parse failure → null body).
      let body: T | null = null;
      try { body = (await res.json()) as T; } catch { body = null; }
      if (!res.ok) log.warn(`[twelvedata] HTTP ${res.status} on ${path} for ${ticker}`);
      return { body, httpStatus: res.status };
    } catch (err) {
      log.warn(`[twelvedata] request failed on ${path} for ${ticker}:`, err instanceof Error ? err.message : err);
      return { body: null };
    }
  }

  private async requestTimeSeries(
    ticker: string,
    barInterval: BarInterval,
    tdInterval: string,
    extra: Record<string, string>,
  ): Promise<OHLCVBar[]> {
    if (this.unsupported.has(ticker)) return [];
    const td = toTwelveDataSymbol(ticker);
    // A ticker the adapter can't parse into a US/LSE listing (an `OTHER`-bucket / malformed
    // string) has no valid /time_series request — sending it anyway is a guaranteed 404 and a
    // wasted credit. Hard-skip: blacklist it (so subsequent polls short-circuit at the check
    // above), log once, and return [] — callers (poll / heal / backfill) already treat an empty
    // result as "no bars for this ticker", so the skip is a no-op for them, not an error.
    if (td === null) {
      this.unsupported.add(ticker);
      log.warn(`[twelvedata] ${ticker} is not a parseable US/LSE ticker — skipped (no request) and blacklisted`);
      return [];
    }
    const query: Record<string, string> = {
      symbol:   td.symbol,
      interval: tdInterval,
      timezone: 'UTC',
      order:    'ASC',
      ...extra,
    };
    if (td.micCode) query.mic_code = td.micCode;
    else if (td.country) query.country = td.country;

    const { body, httpStatus } = await this.get<TdTimeSeriesResponse>('/time_series', query, ticker);

    // A permanent HTTP 404 means the listing is not available to this key — either genuinely
    // absent, or (the free-tier case) paid-walled: TwelveData answers an unentitled symbol
    // with 404 + a "available starting with the Grow or Venture plan" body. Either way it can
    // never succeed on this plan, so blacklist it after the first failure — otherwise the poll
    // (and especially the per-cycle self-heal, which re-requests every "missing" name) burns a
    // credit on it every cycle and floods the logs. 429 is deliberately NOT blacklisted: it is
    // transient minute/credit throttle, not a permanent unavailability.
    if (httpStatus === 404) {
      this.unsupported.add(ticker);
      // Surface the body message when present — TwelveData's 404 body explains *why*
      // (paid-tier wall vs genuinely-absent symbol), which is the actionable diagnostic.
      const reason = body?.message ? `: ${body.message}` : '';
      log.warn(`[twelvedata] ${ticker} (${td.symbol}) HTTP 404 — unavailable on this plan, blacklisted${reason}`);
      return [];
    }
    if (!body) return [];
    if (body.status === 'error') {
      const msg = body.message ?? 'no message';
      // Blacklist any error that signals permanent unavailability so we stop wasting credits:
      //   • "symbol not found" — the symbol isn't in TwelveData's catalog.
      //   • plan-gated — the free tier doesn't serve this listing's /time_series (the
      //     LSE-on-free-Basic case): "available starting with the Grow/Venture plan",
      //     "only available on the Pro plan", "please upgrade". These carry a status:"error"
      //     body but no "not found", so the prior /not found/i test missed them and they
      //     re-requested forever.
      // The discriminator is subscription-PLAN / upgrade vocabulary — NOT the bare word
      // "available". A transient "No data is available on the specified dates." also contains
      // "available", so a loose /available on/ test mis-classified that empty-window case as a
      // permanent wall and blacklisted a still-valid name; key off plan/upgrade instead.
      const permanentlyUnavailable =
        /not found/i.test(msg) ||
        /available starting with/i.test(msg) ||
        /\bupgrad/i.test(msg) ||
        /\bplan\b/i.test(msg);
      if (permanentlyUnavailable) {
        this.unsupported.add(ticker);
        log.warn(`[twelvedata] ${ticker} (${td.symbol}) unavailable — blacklisted: ${msg}`);
      } else {
        log.warn(`[twelvedata] ${ticker} (${td.symbol}) error ${body.code ?? '?'}: ${msg}`);
      }
      return [];
    }
    const values = body.values ?? [];
    if (values.length === 0) return [];

    // Pence-normalisation + currency tagging at the boundary; downstream sees GBP/USD only.
    const { currency, priceScale } = normaliseTwelveDataCurrency(body.meta?.currency);
    const bars: OHLCVBar[] = [];
    for (const v of values) {
      const close = Number(v.close);
      if (!Number.isFinite(close) || close <= 0) continue;
      const obsTs = parseTdDateTime(v.datetime);
      if (!Number.isFinite(obsTs)) continue;
      bars.push({
        ticker,
        observation_ts: obsTs,
        timestamp:      obsTs,
        interval:       barInterval,
        ...(currency ? { currency } : {}),
        open:   numOr(v.open, close) * priceScale,
        high:   numOr(v.high, close) * priceScale,
        low:    numOr(v.low,  close) * priceScale,
        close:  close * priceScale,
        volume: numOr(v.volume, 0),
      });
    }
    // order=ASC already yields oldest-first; sort defensively so fetchHistory's
    // oldest-first contract holds even if TwelveData ever ignores the `order` param.
    bars.sort((a, b) => a.observation_ts - b.observation_ts);
    return bars;
  }
}
