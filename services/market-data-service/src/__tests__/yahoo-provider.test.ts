// Tests for YahooProvider — locks in the interface contract (fetchLatest, fetchRecent,
// fetchHistory, fetchLiquidity) and the lookback-cap truncation/warning behaviour.
//
// The Yahoo HTTP call is mocked via globalThis.fetch so these run hermetically. Symbol
// resolution + blacklist behaviour come from the underlying yahoo-client module — we
// avoid duplicating those tests; here we focus on the provider layer's added logic
// (chunk dispatch, truncation, timestamp normalisation).

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { YahooProvider } from '../providers/yahoo-provider.ts';

interface FetchCall { url: string }

function installFetch(payload: any): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function yahooPayload(timestamps: number[], closes: number[]): any {
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: { quote: [{
          open:   closes,
          high:   closes,
          low:    closes,
          close:  closes,
          volume: closes.map(() => 1000),
        }] },
      }],
      error: null,
    },
  };
}

describe('YahooProvider', () => {
  let spy: ReturnType<typeof installFetch>;
  afterEach(() => { spy?.restore(); });

  it('exposes name and 60-day lookback cap', () => {
    const p = new YahooProvider();
    expect(p.name).toBe('yahoo');
    expect(p.maxLookbackMs).toBe(60 * 24 * 60 * 60_000);
  });

  it('fetchHistory returns 5m-tagged bars with timestamps in ms', async () => {
    // 3 bars at 5m granularity. Yahoo returns timestamps in seconds; provider converts.
    const baseSec = Math.floor(Date.now() / 1000) - 600;
    spy = installFetch(yahooPayload([baseSec, baseSec + 300, baseSec + 600], [100, 101, 102]));
    const p = new YahooProvider();
    const bars = await p.fetchHistory('AAPL_US_EQ', baseSec * 1000);
    expect(bars).toHaveLength(3);
    expect(bars[0].interval).toBe('5m');
    expect(bars[0].timestamp).toBe(baseSec * 1000);
    expect(bars[0].ticker).toBe('AAPL_US_EQ');
    expect(bars[0].close).toBe(100);
  });

  it('fetchHistory returns empty array on empty Yahoo response (no throw)', async () => {
    spy = installFetch({ chart: { result: null, error: null } });
    const p = new YahooProvider();
    const bars = await p.fetchHistory('AAPL_US_EQ', Date.now() - 60_000);
    expect(bars).toEqual([]);
  });

  it('fetchHistory truncates requests older than the 60-day lookback cap', async () => {
    spy = installFetch(yahooPayload([], []));
    const p = new YahooProvider();
    const veryOld = Date.now() - 120 * 24 * 60 * 60_000;  // 120 days ago, past the 60d cap
    await p.fetchHistory('AAPL_US_EQ', veryOld);
    // The single Yahoo call's period1 should be ~60 days ago, NOT 120 days ago.
    const url = spy.calls[0].url;
    const m = url.match(/period1=(\d+)/);
    expect(m).toBeTruthy();
    const period1Sec = parseInt(m![1], 10);
    const earliestExpected = Math.floor((Date.now() - 60 * 24 * 60 * 60_000) / 1000);
    // Allow 5s slop for test clock — provider uses Date.now() at call time.
    expect(period1Sec).toBeGreaterThan(earliestExpected - 5);
  });

  it('fetchHistory returns empty for endTs <= startTs', async () => {
    spy = installFetch(yahooPayload([], []));
    const p = new YahooProvider();
    const out = await p.fetchHistory('AAPL_US_EQ', Date.now(), Date.now() - 1000);
    expect(out).toEqual([]);
    expect(spy.calls).toHaveLength(0);
  });

  // Regression for the deploy-time bug where the caller computed
  // `startTs = Date.now() - 60d`, then fetchHistory's internal Date.now() ran a few ms
  // later, making `startTs < earliest` and silently clamping the window to microseconds.
  // The provider must tolerate boundary-noise — anything within the noise band should
  // proceed without truncation warning AND with a non-degenerate query window.
  it('fetchHistory does NOT log truncation for startTs within the 60s boundary noise band', async () => {
    spy = installFetch(yahooPayload([], []));
    const p = new YahooProvider();
    // Caller computed startTs a few ms before us — slightly past `Date.now() - 60d`.
    const startTs = Date.now() - p.maxLookbackMs - 100;  // 100ms past the cap

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
      await p.fetchHistory('AAPL_US_EQ', startTs);
    } finally {
      console.warn = originalWarn;
    }

    // No truncation warning for sub-60s overshoot — this is the "noise band" the fix introduced.
    expect(warnings.filter((w) => w.includes('truncated'))).toEqual([]);
    // And the query must still go out (not silently dropped to empty range)
    expect(spy.calls).toHaveLength(1);
  });

  it('fetchHistory DOES log truncation when startTs is well past the cap', async () => {
    spy = installFetch(yahooPayload([], []));
    const p = new YahooProvider();
    const veryOld = Date.now() - 2 * p.maxLookbackMs;  // 120 days ago — way past
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => { warnings.push(args.join(' ')); };
    try {
      await p.fetchHistory('AAPL_US_EQ', veryOld);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes('truncated'))).toBe(true);
  });
});
