// Tests for TwelveDataProvider — locks in the MarketDataProvider contract (fetchHistory,
// fetchRecent, fetchLiquidity), the symbol mapping (US → country, LSE → mic_code), pence
// normalisation, the not-found blacklist, the lookback-cap truncation, and the free-tier
// daily-credit short-circuit.
//
// The TwelveData HTTP call is mocked via globalThis.fetch so these run hermetically. Each
// test builds a fresh provider so the per-instance credit limiter + blacklist don't bleed
// across cases. creditsPerMinute is set high so the per-minute pacing never sleeps in tests.

import { describe, it, expect, afterEach } from "vitest";
import { TwelveDataProvider } from '../modules/bars/infrastructure/providers/twelvedata-provider.ts';
import { normaliseTwelveDataCurrency, toTwelveDataSymbol } from '../modules/bars/infrastructure/providers/twelvedata-client.ts';

interface FetchCall { url: string }

// payloadFor lets a test vary the response by URL (e.g. blacklist behaviour). Most tests
// just return a constant payload regardless of url.
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

// TwelveData /time_series payload (single symbol). `values` newest-or-oldest order is the
// caller's choice — the provider sorts oldest-first defensively, which we assert below.
function tdSeries(values: Array<[string, number]>, currency?: string): unknown {
  return {
    meta: currency ? { currency } : {},
    values: values.map(([datetime, close]) => ({
      datetime,
      open:   String(close),
      high:   String(close),
      low:    String(close),
      close:  String(close),
      volume: '1000',
    })),
    status: 'ok',
  };
}

const OPTS = { apiKey: 'test-key', creditsPerMinute: 1000, dailyCreditLimit: 1000 };

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('TwelveDataProvider', () => {
  let spy: ReturnType<typeof installFetch>;
  afterEach(() => { spy?.restore(); });

  it('exposes name, 60-day lookback cap, and 24h-only poll cadence', () => {
    const p = new TwelveDataProvider(OPTS);
    expect(p.name).toBe('twelvedata');
    expect(p.maxLookbackMs).toBe(60 * 24 * 60 * 60_000);
    expect(p.allowedPollIntervals).toEqual(['24h']);
  });

  it('fetchHistory returns 5m-tagged bars, oldest-first, with ms timestamps', async () => {
    // Provide DESCENDING values to prove the provider re-sorts to oldest-first.
    spy = installFetch(() => tdSeries([
      ['2026-05-20 14:40:00', 102],
      ['2026-05-20 14:35:00', 101],
      ['2026-05-20 14:30:00', 100],
    ], 'USD'));
    const p = new TwelveDataProvider(OPTS);
    const bars = await p.fetchHistory('AAPL_US_EQ', Date.parse('2026-05-20T14:00:00Z'), Date.parse('2026-05-20T15:00:00Z'));
    expect(bars).toHaveLength(3);
    expect(bars.map((b) => b.close)).toEqual([100, 101, 102]);     // ascending by time
    expect(bars[0].interval).toBe('5m');
    expect(bars[0].ticker).toBe('AAPL_US_EQ');
    expect(bars[0].observation_ts).toBe(Date.parse('2026-05-20T14:30:00Z'));
    expect(bars[0].timestamp).toBe(bars[0].observation_ts);
  });

  it('fetchHistory returns [] on empty TwelveData values (no throw)', async () => {
    spy = installFetch(() => ({ meta: {}, values: [], status: 'ok' }));
    const p = new TwelveDataProvider(OPTS);
    const bars = await p.fetchHistory('AAPL_US_EQ', Date.now() - 60_000);
    expect(bars).toEqual([]);
  });

  it('fetchHistory returns [] for endTs <= startTs without calling upstream', async () => {
    spy = installFetch(() => tdSeries([]));
    const p = new TwelveDataProvider(OPTS);
    const out = await p.fetchHistory('AAPL_US_EQ', Date.now(), Date.now() - 1000);
    expect(out).toEqual([]);
    expect(spy.calls).toHaveLength(0);
  });

  it('fetchHistory truncates the start_date to the 60-day cap', async () => {
    spy = installFetch(() => tdSeries([]));
    const p = new TwelveDataProvider(OPTS);
    const veryOld = Date.now() - 120 * 24 * 60 * 60_000;     // 120 days ago — past the 60d cap
    await p.fetchHistory('AAPL_US_EQ', veryOld);
    const startDate = paramsOf(spy.calls[0].url).get('start_date');
    expect(startDate).toBeTruthy();
    const startMs = Date.parse(`${startDate!.replace(' ', 'T')}Z`);
    const earliestExpected = Date.now() - 60 * 24 * 60 * 60_000;
    // start_date should be ~60d ago (the cap), NOT 120d ago. Allow 5s slop for test clock.
    expect(startMs).toBeGreaterThan(earliestExpected - 5_000);
  });

  describe('symbol mapping', () => {
    it('US ticker → bare symbol + country, with the api key attached', async () => {
      spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 100]], 'USD'));
      const p = new TwelveDataProvider(OPTS);
      await p.fetchHistory('AAPL_US_EQ', Date.now() - 60_000);
      const q = paramsOf(spy.calls[0].url);
      expect(q.get('symbol')).toBe('AAPL');
      expect(q.get('country')).toBe('United States');
      expect(q.get('mic_code')).toBeNull();
      expect(q.get('interval')).toBe('5min');
      expect(q.get('timezone')).toBe('UTC');
      expect(q.get('order')).toBe('ASC');
      expect(q.get('apikey')).toBe('test-key');
    });

    it('LSE ticker (l_EQ) → base symbol + mic_code=XLON', async () => {
      spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 870]], 'GBp'));
      const p = new TwelveDataProvider(OPTS);
      await p.fetchHistory('HSBAl_EQ', Date.now() - 60_000);
      const q = paramsOf(spy.calls[0].url);
      expect(q.get('symbol')).toBe('HSBA');
      expect(q.get('mic_code')).toBe('XLON');
      expect(q.get('country')).toBeNull();
    });

    it('toTwelveDataSymbol applies SYMBOL_RENAMES (FB → META)', () => {
      expect(toTwelveDataSymbol('FB_US_EQ')).toEqual({ symbol: 'META', country: 'United States' });
    });
  });

  describe('currency normalisation', () => {
    it('tags USD bars and leaves prices at face value', async () => {
      spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 250.25]], 'USD'));
      const p = new TwelveDataProvider(OPTS);
      const bars = await p.fetchHistory('AAPL_US_EQ', Date.now() - 60_000);
      expect(bars[0].currency).toBe('USD');
      expect(bars[0].close).toBeCloseTo(250.25, 4);
    });

    it('scales GBp (pence) by 1/100 and tags GBP', async () => {
      spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 870]], 'GBp'));
      const p = new TwelveDataProvider(OPTS);
      const bars = await p.fetchHistory('HSBAl_EQ', Date.now() - 60_000);
      expect(bars[0].currency).toBe('GBP');
      expect(bars[0].close).toBeCloseTo(8.70, 4);
      expect(bars[0].volume).toBe(1000);   // volume is share count, unaffected by price scale
    });

    it('handles GBX identically to GBp', () => {
      expect(normaliseTwelveDataCurrency('GBX')).toEqual({ currency: 'GBP', priceScale: 0.01 });
      expect(normaliseTwelveDataCurrency('GBp')).toEqual({ currency: 'GBP', priceScale: 0.01 });
      expect(normaliseTwelveDataCurrency('GBP')).toEqual({ currency: 'GBP', priceScale: 1 });
    });

    it('omits the currency tag when TwelveData returns no currency meta', async () => {
      spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 100]]));   // no currency
      const p = new TwelveDataProvider(OPTS);
      const bars = await p.fetchHistory('UNKNOWN', Date.now() - 60_000);
      expect(bars[0].currency).toBeUndefined();
      expect(bars[0].close).toBe(100);
    });
  });

  it('blacklists a "not found" symbol and stops re-requesting it', async () => {
    spy = installFetch(() => ({ code: 400, message: 'symbol not found: ZZZZ', status: 'error' }));
    const p = new TwelveDataProvider(OPTS);
    const first = await p.fetchHistory('ZZZZ_US_EQ', Date.now() - 60_000);
    const second = await p.fetchHistory('ZZZZ_US_EQ', Date.now() - 60_000);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(spy.calls).toHaveLength(1);                       // second call short-circuited by blacklist
  });

  it('stops calling upstream once the daily credit budget is exhausted', async () => {
    spy = installFetch(() => tdSeries([['2026-05-20 14:30:00', 100]], 'USD'));
    const p = new TwelveDataProvider({ apiKey: 'k', creditsPerMinute: 1000, dailyCreditLimit: 1 });
    const first = await p.fetchHistory('AAPL_US_EQ', Date.now() - 60_000);
    const second = await p.fetchHistory('MSFT_US_EQ', Date.now() - 60_000);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);                              // budget gone → degrade to empty
    expect(spy.calls).toHaveLength(1);                       // no second network call
    expect(p.creditsUsedToday).toBe(1);
  });

  it('fetchLiquidity averages close×volume across the daily window', async () => {
    spy = installFetch(() => tdSeries([
      ['2026-05-16', 100],
      ['2026-05-17', 100],
    ], 'USD'));
    const p = new TwelveDataProvider(OPTS);   // no FX → identity; ADV stays in native units
    const adv = await p.fetchLiquidity(['AAPL_US_EQ']);
    expect(adv['AAPL_US_EQ']).toBeCloseTo(100 * 1000, 4);    // close 100 × volume 1000
  });
});
