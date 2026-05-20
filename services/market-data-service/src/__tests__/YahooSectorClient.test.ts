import { describe, it, expect } from 'vitest';
import { YahooSectorClient } from '../modules/universe/infrastructure/yahoo-sector-client.ts';

// Build a fake fetch that responds based on the requested URL. Captures the call log
// so tests can assert retry counts + memo behaviour.
//
// Yahoo's quoteSummary now requires a session (cookie + crumb), so every fetchOne
// goes through the seed + crumb URLs first. Default handlers cover those — tests
// only need to override them when exercising the auth path itself.
function makeFetchMock(handlers: Record<string, () => Promise<Response> | Response>) {
  const calls: string[] = [];
  const defaults: Record<string, () => Response> = {
    'fc.yahoo.com': () => new Response('', { status: 302, headers: { 'set-cookie': 'A1=stub; Path=/' } }),
    'getcrumb':     () => new Response('STUBCRUMB', { status: 200, headers: { 'content-type': 'text/plain' } }),
  };
  const merged = { ...defaults, ...handlers };
  const fn = async (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push(u);
    for (const [key, handler] of Object.entries(merged)) {
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

// Count just the upstream quoteSummary hits — ignores the one-shot session-acquire
// pair (seed + crumb) so retry/memo assertions remain about ticker traffic only.
const quoteCalls = (calls: string[]): string[] => calls.filter((u) => u.includes('quoteSummary'));

describe('YahooSectorClient', () => {
  it('returns sector + industry on success', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology', 'Consumer Electronics'),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const got = await c.fetchOne('AAPL_US_EQ');
    expect(got).toEqual({ ticker: 'AAPL_US_EQ', sector: 'Technology', industry: 'Consumer Electronics' });
    expect(quoteCalls(fetchFn.calls)).toHaveLength(1);
  });

  it('returns null on 404 without retrying (unknown symbol)', async () => {
    const fetchFn = makeFetchMock({
      'BOGUS': () => new Response('', { status: 404 }),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    const got = await c.fetchOne('BOGUS_US_EQ');
    expect(got).toBeNull();
    expect(quoteCalls(fetchFn.calls)).toHaveLength(1);   // no retries on 404 — Yahoo doesn't know
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
    // Still only ONE quoteSummary call — soft misses don't retry.
    expect(quoteCalls(fetchFn.calls)).toHaveLength(1);
  });

  it('memoises hits across calls within the same client lifetime', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology'),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    await c.fetchOne('AAPL_US_EQ');
    await c.fetchOne('AAPL_US_EQ');
    expect(quoteCalls(fetchFn.calls)).toHaveLength(1);
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

  it('acquires session (cookie + crumb) once, then attaches both to quoteSummary calls', async () => {
    const fetchFn = makeFetchMock({
      'AAPL': () => payload('Technology'),
      'MSFT': () => payload('Technology'),
    });
    const c = new YahooSectorClient({ fetchFn, ...NO_DELAY });
    await c.fetchOne('AAPL_US_EQ');
    await c.fetchOne('MSFT_US_EQ');
    // First-use: seed + crumb + quote. Second-use: just quote (session cached).
    const seedCalls  = fetchFn.calls.filter((u) => u.includes('fc.yahoo.com')).length;
    const crumbCalls = fetchFn.calls.filter((u) => u.includes('getcrumb')).length;
    const quoteCalls = fetchFn.calls.filter((u) => u.includes('quoteSummary'));
    expect(seedCalls).toBe(1);
    expect(crumbCalls).toBe(1);
    expect(quoteCalls).toHaveLength(2);
    expect(quoteCalls[0]).toContain('crumb=STUBCRUMB');
    expect(quoteCalls[1]).toContain('crumb=STUBCRUMB');
  });

  it('on 401 invalidates the session and re-acquires on the next attempt', async () => {
    let quoteHits = 0;
    const fetchFn = makeFetchMock({
      'AAPL': () => {
        quoteHits++;
        return quoteHits === 1
          ? new Response('', { status: 401 })
          : payload('Technology');
      },
    });
    const c = new YahooSectorClient({ fetchFn, maxAttempts: 3, retryBackoffMs: 0, interRequestMs: 0 });
    const got = await c.fetchOne('AAPL_US_EQ');
    expect(got?.sector).toBe('Technology');
    // First attempt 401 drops the session — second attempt re-acquires it before quoting.
    const seedCalls = fetchFn.calls.filter((u) => u.includes('fc.yahoo.com')).length;
    expect(seedCalls).toBe(2);
    expect(quoteHits).toBe(2);
  });
});
