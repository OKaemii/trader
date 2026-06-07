// eodhd-client — symbol/currency mapping, screener + bulk parsing, the daily-history adapter
// (fetchEodhdDailyHistory) that mirrors fetchYahooDailyHistory, and the thin feed methods
// (technical/dividends/splits/news/exchangeDetails/exchangesList). The EODHD HTTP call is mocked
// via globalThis.fetch so these run hermetically.

import { describe, it, expect, afterEach } from 'vitest';
import {
  EodhdClient,
  configureEodhdClient,
  _setEodhdClientForTest,
  fetchEodhdDailyHistory,
  toEodhdSymbol,
  eodhdCurrencyForExchange,
} from '../modules/bars/infrastructure/providers/eodhd-client.ts';

interface FetchCall { url: string }
function installFetch(payloadFor: (url: string) => unknown): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    calls.push({ url: u });
    return new Response(JSON.stringify(payloadFor(u)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
function paramsOf(url: string): URLSearchParams { return new URL(url).searchParams; }

describe('eodhd-client', () => {
  let spy: ReturnType<typeof installFetch> | undefined;
  afterEach(() => { spy?.restore(); spy = undefined; _setEodhdClientForTest(null); });

  describe('symbol mapping + currency', () => {
    it('maps US/LSE tickers and applies SYMBOL_RENAMES', () => {
      expect(toEodhdSymbol('AAPL_US_EQ')).toBe('AAPL.US');
      expect(toEodhdSymbol('HSBAl_EQ')).toBe('HSBA.LSE');
      expect(toEodhdSymbol('FB_US_EQ')).toBe('META.US');
    });
    it('infers USD for US and pence->GBP for LSE', () => {
      expect(eodhdCurrencyForExchange('US')).toEqual({ currency: 'USD', priceScale: 1 });
      expect(eodhdCurrencyForExchange('LSE')).toEqual({ currency: 'GBP', priceScale: 0.01 });
    });
  });

  it('screener parses rows, drops codeless rows, attaches api_token/fmt', async () => {
    spy = installFetch(() => ({ data: [
      { code: 'AAPL', name: 'Apple', exchange: 'US', market_capitalization: 3.2e12, currency_symbol: 'USD', sector: 'Technology' },
      { code: '', name: 'junk' },
    ] }));
    const c = new EodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const rows = await c.screener([['market_capitalization', '>', 6e9]], 'market_capitalization.desc', 100, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'AAPL', exchange: 'US', marketCap: 3.2e12, currency: 'USD', sector: 'Technology' });
    const q = paramsOf(spy!.calls[0]!.url);
    expect(q.get('api_token')).toBe('k');
    expect(q.get('fmt')).toBe('json');
    expect(q.get('limit')).toBe('100');
  });

  it('bulkLastDay parses rows and drops non-finite closes', async () => {
    spy = installFetch(() => [
      { code: 'AAPL', date: '2026-06-01', open: 1, high: 2, low: 1, close: 200, adjusted_close: 200, volume: 1000 },
      { code: 'BAD', date: '2026-06-01', close: 'x' },
    ]);
    const c = new EodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const rows = await c.bulkLastDay('US');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe('AAPL');
  });

  it('fetchEodhdDailyHistory builds adjusted, oldest-first daily bars (US)', async () => {
    // adjusted_close 50 vs raw close 100 → factor 0.5; OHLC scaled by the same factor.
    spy = installFetch(() => [
      { date: '2026-05-21', open: 102, high: 103, low: 101, close: 102, adjusted_close: 102, volume: 20 },
      { date: '2026-05-20', open: 100, high: 101, low: 99, close: 100, adjusted_close: 50, volume: 10 },
    ]);
    configureEodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const bars = await fetchEodhdDailyHistory('AAPL_US_EQ', Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-05-31T00:00:00Z'));
    expect(bars).toHaveLength(2);
    expect(bars[0]!.observation_ts).toBe(Date.parse('2026-05-20T00:00:00Z'));   // oldest-first
    expect(bars[0]!.interval).toBe('daily');
    expect(bars[0]!.currency).toBe('USD');
    expect(bars[0]!.close).toBeCloseTo(50, 6);
    expect(bars[0]!.rawClose).toBeCloseTo(100, 6);
    expect(bars[0]!.adjustmentFactor).toBeCloseTo(0.5, 6);
    expect(bars[0]!.open).toBeCloseTo(50, 6);            // 100 * 0.5
  });

  it('fetchEodhdDailyHistory scales LSE pence to GBP', async () => {
    spy = installFetch(() => [
      { date: '2026-05-20', open: 870, high: 875, low: 865, close: 870, adjusted_close: 870, volume: 10 },
    ]);
    configureEodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const bars = await fetchEodhdDailyHistory('HSBAl_EQ', Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-05-31T00:00:00Z'));
    expect(bars[0]!.currency).toBe('GBP');
    expect(bars[0]!.close).toBeCloseTo(8.70, 6);
  });

  it('degrades to empty (no network call) when the daily budget is exhausted', async () => {
    spy = installFetch(() => [{ date: '2026-05-20', open: 1, high: 1, low: 1, close: 1, adjusted_close: 1, volume: 1 }]);
    configureEodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 0 });
    const bars = await fetchEodhdDailyHistory('AAPL_US_EQ', Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-05-31T00:00:00Z'));
    expect(bars).toEqual([]);
    expect(spy!.calls).toHaveLength(0);
  });

  // ── Thin feed methods (Task 13) ──────────────────────────────────────────────────
  const newClient = () => new EodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });

  describe('technical', () => {
    it('parses each date into a finite-only values map and passes function + params through', async () => {
      spy = installFetch(() => [
        { date: '2026-06-01', macd: 1.2, signal: 0.9, divergence: 0.3 },
        { date: '2026-06-02', macd: 'NA', signal: 1.0, divergence: 'x' },   // drops non-finite keys
        { date: '', macd: 5 },                                              // dropped: no date
      ]);
      const rows = await newClient().technical('AAPL.US', 'macd', { period: '14', from: '2026-06-01' });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ date: '2026-06-01', values: { macd: 1.2, signal: 0.9, divergence: 0.3 } });
      expect(rows[1]!.values).toEqual({ signal: 1.0 });                     // NA + 'x' dropped
      const q = paramsOf(spy!.calls[0]!.url);
      expect(new URL(spy!.calls[0]!.url).pathname).toContain('/technical/AAPL.US');
      expect(q.get('function')).toBe('macd');
      expect(q.get('period')).toBe('14');
      expect(q.get('from')).toBe('2026-06-01');
    });
    it('degrades to [] on a non-array body', async () => {
      spy = installFetch(() => ({ error: 'nope' }));
      expect(await newClient().technical('AAPL.US', 'rsi')).toEqual([]);
    });
  });

  describe('dividends', () => {
    it('parses per-share values, keeps optional dates, drops non-finite/dateless rows', async () => {
      spy = installFetch(() => [
        { date: '2026-02-10', value: 0.24, currency: 'USD', declarationDate: '2026-01-15', recordDate: '2026-02-11', paymentDate: '2026-02-20' },
        { date: '2026-05-12', value: 0.25 },
        { date: '2026-08-10', value: 'NA' },          // dropped: non-finite value
        { date: '', value: 0.3 },                     // dropped: no date
      ]);
      const rows = await newClient().dividends('AAPL.US', '2026-01-01', '2026-12-31');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        date: '2026-02-10', value: 0.24, currency: 'USD',
        declarationDate: '2026-01-15', recordDate: '2026-02-11', paymentDate: '2026-02-20',
      });
      expect(rows[1]).toEqual({ date: '2026-05-12', value: 0.25 });   // no optional keys when absent
      const q = paramsOf(spy!.calls[0]!.url);
      expect(new URL(spy!.calls[0]!.url).pathname).toContain('/div/AAPL.US');
      expect(q.get('from')).toBe('2026-01-01');
      expect(q.get('to')).toBe('2026-12-31');
    });
    it('omits from/to when not supplied', async () => {
      spy = installFetch(() => []);
      await newClient().dividends('AAPL.US');
      const q = paramsOf(spy!.calls[0]!.url);
      expect(q.has('from')).toBe(false);
      expect(q.has('to')).toBe(false);
    });
  });

  describe('splits', () => {
    it('parses the ratio into a share-count factor (incl. reverse split) and keeps the raw string', async () => {
      spy = installFetch(() => [
        { date: '2020-08-31', split: '4/1' },
        { date: '2022-06-06', split: '3/2' },
        { date: '2024-01-01', split: '1/4' },      // reverse split → 0.25
        { date: '2025-01-01', split: 'junk' },     // unparseable → factor NaN, still kept
        { date: '', split: '2/1' },                // dropped: no date
      ]);
      const rows = await newClient().splits('AAPL.US');
      expect(rows).toHaveLength(4);
      expect(rows[0]).toEqual({ date: '2020-08-31', ratio: '4/1', factor: 4 });
      expect(rows[1]!.factor).toBeCloseTo(1.5, 6);
      expect(rows[2]!.factor).toBeCloseTo(0.25, 6);
      expect(Number.isNaN(rows[3]!.factor)).toBe(true);
      expect(rows[3]!.ratio).toBe('junk');
      expect(new URL(spy!.calls[0]!.url).pathname).toContain('/splits/AAPL.US');
    });
  });

  describe('news', () => {
    it('keeps title/link/date/symbols/tags, surfaces sentiment only when present, clamps limit', async () => {
      spy = installFetch(() => [
        { date: '2026-06-01T12:00:00+00:00', title: 'Apple beats', link: 'https://x/1', symbols: ['AAPL.US'], tags: ['earnings'],
          sentiment: { polarity: 0.8, neg: 0.05, neu: 0.15, pos: 0.8 } },
        { date: '2026-06-02T09:00:00+00:00', title: 'No sentiment', link: 'https://x/2' },   // no symbols/tags/sentiment
        { date: '2026-06-03T09:00:00+00:00', title: '', link: 'https://x/3' },               // dropped: no title
      ]);
      const rows = await newClient().news('AAPL.US', { limit: 5000, offset: 10, from: '2026-06-01' });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        date: '2026-06-01T12:00:00+00:00', title: 'Apple beats', link: 'https://x/1',
        symbols: ['AAPL.US'], tags: ['earnings'], sentiment: { polarity: 0.8, neg: 0.05, neu: 0.15, pos: 0.8 },
      });
      expect(rows[1]).toEqual({ date: '2026-06-02T09:00:00+00:00', title: 'No sentiment', link: 'https://x/2', symbols: [], tags: [] });
      const q = paramsOf(spy!.calls[0]!.url);
      expect(q.get('s')).toBe('AAPL.US');
      expect(q.get('limit')).toBe('1000');     // clamped from 5000
      expect(q.get('offset')).toBe('10');
      expect(q.get('from')).toBe('2026-06-01');
    });
  });

  describe('exchangeDetails', () => {
    it('parses identity, trading hours, and flattens the keyed holiday object', async () => {
      spy = installFetch(() => ({
        Name: 'London Exchange', Code: 'LSE', OperatingMIC: 'XLON', Country: 'UK', Currency: 'GBP',
        CountryISO2: 'GB', CountryISO3: 'GBR',
        TradingHours: { Open: '08:00:00', Close: '16:30:00', WorkingDays: 'Mon,Tue,Wed,Thu,Fri', OpenUTC: '08:00:00', CloseUTC: '16:30:00' },
        ExchangeHolidays: {
          '0': { Date: '2026-12-25', Holiday: 'Christmas Day', Type: 'holiday' },
          '1': { Date: '2026-12-24', Holiday: 'Christmas Eve', Type: 'half-day' },
          '2': { Date: '', Holiday: 'junk' },     // dropped: no date
        },
      }));
      const d = await newClient().exchangeDetails('LSE');
      expect(d).not.toBeNull();
      expect(d!).toMatchObject({ name: 'London Exchange', code: 'LSE', operatingMIC: 'XLON', country: 'UK', currency: 'GBP' });
      expect(d!.tradingHours).toEqual({ open: '08:00:00', close: '16:30:00', workingDays: 'Mon,Tue,Wed,Thu,Fri', openUTC: '08:00:00', closeUTC: '16:30:00' });
      expect(d!.holidays).toHaveLength(2);
      expect(d!.holidays[0]).toEqual({ date: '2026-12-25', name: 'Christmas Day', type: 'holiday' });
      expect(d!.holidays[1]!.type).toBe('half-day');
      expect(new URL(spy!.calls[0]!.url).pathname).toContain('/exchange-details/LSE');
    });
    it('returns null on an error body (distinct from loaded-with-no-holidays)', async () => {
      spy = installFetch(() => 'not an object');
      const d = await newClient().exchangeDetails('LSE');
      expect(d).toBeNull();
    });
    it('returns [] holidays when the field is absent', async () => {
      spy = installFetch(() => ({ Name: 'NYSE', Code: 'US' }));
      const d = await newClient().exchangeDetails('US');
      expect(d!.holidays).toEqual([]);
      expect(d!.tradingHours).toBeUndefined();
    });
  });

  describe('exchangesList', () => {
    it('parses identity rows and drops codeless rows', async () => {
      spy = installFetch(() => [
        { Name: 'USA Stocks', Code: 'US', OperatingMIC: 'XNAS, XNYS', Country: 'USA', Currency: 'USD', CountryISO2: 'US', CountryISO3: 'USA' },
        { Name: 'London', Code: 'LSE', Country: 'UK', Currency: 'GBP' },
        { Name: 'junk', Code: '' },     // dropped
      ]);
      const rows = await newClient().exchangesList();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ name: 'USA Stocks', code: 'US', operatingMIC: 'XNAS, XNYS', currency: 'USD' });
      expect(rows[1]).toEqual({ name: 'London', code: 'LSE', country: 'UK', currency: 'GBP' });
      expect(new URL(spy!.calls[0]!.url).pathname).toContain('/exchanges-list/');
    });
  });

  it('thin methods degrade to empty / null on budget exhaustion (no network call)', async () => {
    spy = installFetch(() => [{ date: '2026-06-01', value: 1 }]);
    const c = new EodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 0 });
    expect(await c.technical('AAPL.US', 'rsi')).toEqual([]);
    expect(await c.dividends('AAPL.US')).toEqual([]);
    expect(await c.splits('AAPL.US')).toEqual([]);
    expect(await c.news('AAPL.US')).toEqual([]);
    expect(await c.exchangeDetails('US')).toBeNull();
    expect(await c.exchangesList()).toEqual([]);
    expect(spy!.calls).toHaveLength(0);
  });
});
