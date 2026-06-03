// eodhd-client — symbol/currency mapping, screener + bulk parsing, and the daily-history
// adapter (fetchEodhdDailyHistory) that mirrors fetchYahooDailyHistory. The EODHD HTTP call is
// mocked via globalThis.fetch so these run hermetically.

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
      { code: 'AAPL', name: 'Apple', exchange: 'US', market_capitalization: 3.2e12, currency_symbol: 'USD' },
      { code: '', name: 'junk' },
    ] }));
    const c = new EodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const rows = await c.screener([['market_capitalization', '>', 6e9]], 'market_capitalization.desc', 100, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'AAPL', exchange: 'US', marketCap: 3.2e12, currency: 'USD' });
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
});
