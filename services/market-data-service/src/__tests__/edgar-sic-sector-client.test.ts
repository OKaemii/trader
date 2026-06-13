// EdgarSicSectorClient — the SECONDARY (EDGAR-SIC) sector source for the universe (Task 19).
//
// Pins:
//   - a US name's sector resolves from fundamentals-api's /sectors response (keyed on the request ticker);
//   - non-US names are filtered out BEFORE the call (no EDGAR presence) — the request only carries US names;
//   - every failure mode (non-200 / 503 cold lake / malformed body / transport throw / empty) → {} (graceful);
//   - the internal JWT is minted as 'market-data-service' and sent as a Bearer token.
process.env.JWT_SECRET = 'test-jwt-secret-min-16-chars';

import { describe, it, expect, vi } from 'vitest';
import { EdgarSicSectorClient } from '../modules/universe/infrastructure/edgar-sic-sector-client.ts';

const BASE = 'http://fundamentals-api:8011';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function clientWith(fetchFn: typeof fetch) {
  return new EdgarSicSectorClient({
    baseUrl: BASE,
    fetchFn,
    mintToken: async (caller: string) => `token-for-${caller}`,
  });
}

describe('EdgarSicSectorClient.fetchSectors', () => {
  it('returns the per-ticker sector map for US names', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ sectors: { AAPL_US_EQ: 'Technology', JPM_US_EQ: 'Financial Services' }, count: 2 }),
    ) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ', 'JPM_US_EQ']);
    expect(out).toEqual({ AAPL_US_EQ: 'Technology', JPM_US_EQ: 'Financial Services' });
  });

  it('only sends US names (non-US filtered out before the call)', async () => {
    let calledUrl = '';
    const fetchFn = vi.fn(async (url: string) => { calledUrl = url; return jsonResponse({ sectors: { AAPL_US_EQ: 'Technology' } }); }) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ', 'SHELl_EQ', 'HSBAl_EQ']);
    // The LSE names are never in the query string; only the US name is.
    expect(calledUrl).toContain('symbols=AAPL_US_EQ');
    expect(calledUrl).not.toContain('SHEL');
    expect(calledUrl).not.toContain('HSBA');
    expect(out).toEqual({ AAPL_US_EQ: 'Technology' });
  });

  it('returns {} without calling fetch when there are no US names', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ sectors: {} })) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['SHELl_EQ', 'HSBAl_EQ']);
    expect(out).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sends the internal JWT as a Bearer token minted for market-data-service', async () => {
    const seen: Record<string, string> = {};
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return jsonResponse({ sectors: { AAPL_US_EQ: 'Technology' } });
    }) as unknown as typeof fetch;
    await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ']);
    expect(seen.auth).toBe('Bearer token-for-market-data-service');
  });

  it('degrades a 503 cold lake to {} (graceful, no throw)', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ detail: 'sectors unavailable' }, 503)) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ']);
    expect(out).toEqual({});
  });

  it('degrades a malformed body to {}', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ not_sectors: 1 })) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ']);
    expect(out).toEqual({});
  });

  it('degrades a transport throw to {}', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ']);
    expect(out).toEqual({});
  });

  it('drops non-string / empty sector values defensively', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ sectors: { AAPL_US_EQ: 'Technology', BAD_US_EQ: 42, EMPTY_US_EQ: '  ' } }),
    ) as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors(['AAPL_US_EQ', 'BAD_US_EQ', 'EMPTY_US_EQ']);
    expect(out).toEqual({ AAPL_US_EQ: 'Technology' });
  });

  it('returns {} for an empty ticker list', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const out = await clientWith(fetchFn).fetchSectors([]);
    expect(out).toEqual({});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
