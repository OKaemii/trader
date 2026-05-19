import { describe, it, expect } from 'vitest';
import { YahooSectorClient } from '../modules/universe/infrastructure/yahoo-sector-client.ts';

// Build a fake fetch that responds based on the requested URL. Captures the call log
// so tests can assert retry counts + memo behaviour.
function makeFetchMock(handlers: Record<string, () => Promise<Response> | Response>) {
  const calls: string[] = [];
  const fn = async (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push(u);
    for (const [key, handler] of Object.entries(handlers)) {
      if (u.includes(key)) return handler();
    }
    return new Response('not found', { status: 404 });
  };
  return Object.assign(fn, { calls });
}

function payload(sector: string, industry?: string) {
  return new Response(JSON.stringify({
    quoteSummary: {
      result: [{ assetProfile: { sector, ...(industry ? { industry } : {}) } }],
      error: null,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const NO_DELAY = { retryBackoffMs: 0, interRequestMs: 0 };

describe('YahooSectorClient', () => {
  it('returns sector + industry on success', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology', 'Consumer Electronics'),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const got = await c.fetchOne('AAPL_US_EQ');
    expect(got).toEqual({ ticker: 'AAPL_US_EQ', sector: 'Technology', industry: 'Consumer Electronics' });
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('returns null on 404 without retrying (unknown symbol)', async () => {
    const fetchFn = makeFetchMock({
      'BOGUS': () => new Response('', { status: 404 }),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const got = await c.fetchOne('BOGUS_US_EQ');
    expect(got).toBeNull();
    expect(fetchFn.calls).toHaveLength(1);   // no retries on 404 — Yahoo doesn't know
  });

  it('retries up to maxAttempts on transient 5xx then gives up', async () => {
    let attempts = 0;
    const fetchFn = makeFetchMock({
      'AAPL': () => {
        attempts++;
        return new Response('boom', { status: 503 });
      },
    });
    const c = new YahooSectorClient({ fetchFn, maxAttempts: 3, retryBackoffMs: 0, interRequestMs: 0 });
    const got = await c.fetchOne('AAPL_US_EQ');
    expect(got).toBeNull();
    expect(attempts).toBe(3);
  });

  it('soft-misses when payload omits assetProfile.sector', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => new Response(JSON.stringify({
        quoteSummary: { result: [{ assetProfile: { industry: 'Whatever' } }], error: null },
      }), { status: 200 }),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const got = await c.fetchOne('AAPL_US_EQ');
    expect(got).toBeNull();
    // Still only ONE call — soft misses don't retry.
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('memoises hits across calls within the same client lifetime', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology'),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    await c.fetchOne('AAPL_US_EQ');
    await c.fetchOne('AAPL_US_EQ');
    expect(fetchFn.calls).toHaveLength(1);
  });

  it('fetchSectors returns a partial map (missing tickers absent)', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology'),
      'MSFT': () => payload('Technology'),
      'BOGUS': () => new Response('', { status: 404 }),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const map = await c.fetchSectors(['AAPL_US_EQ', 'MSFT_US_EQ', 'BOGUS_US_EQ']);
    expect(Object.keys(map).sort()).toEqual(['AAPL_US_EQ', 'MSFT_US_EQ']);
    expect(map.AAPL_US_EQ.sector).toBe('Technology');
  });
});
