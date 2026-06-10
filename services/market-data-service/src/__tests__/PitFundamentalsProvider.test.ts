// PitFundamentalsProvider — US→PIT mapping, non-US→Yahoo, PIT-miss→Yahoo, api-down→Yahoo (degrade,
// never throw). The fundamentals-api HTTP call and the Yahoo fall-back are both stubbed so the test
// is hermetic (no live signer, no network, no Mongo).

import { describe, it, expect, vi } from 'vitest';
import {
  PitFundamentalsProvider,
  SOURCE_PIT_EDGAR,
  SOURCE_YAHOO,
} from '../modules/fundamentals/infrastructure/PitFundamentalsProvider.ts';
import type { FundamentalsProvider, FundamentalsRaw } from '../modules/fundamentals/infrastructure/FundamentalsProvider.ts';

const BASE = 'http://fundamentals-api:8011';

// A fixed Yahoo fall-back stub: returns a known FundamentalsRaw for every ticker it's asked about,
// so we can assert which names were routed to it. `seen` records its input for routing assertions.
function fakeYahoo(): FundamentalsProvider & { seen: string[][] } {
  const seen: string[][] = [];
  return {
    seen,
    async fetch(tickers: string[]): Promise<Record<string, FundamentalsRaw>> {
      seen.push(tickers);
      const out: Record<string, FundamentalsRaw> = {};
      for (const t of tickers) {
        out[t] = {
          netIncome: 1, totalEquity: 2, totalDebt: 3,
          currentAssets: 4, currentLiabilities: 5, marketCapGbp: 6,
        };
      }
      return out;
    },
  };
}

// A fundamentals-api `{ fundamentals: { ticker: payload } }` response body builder.
function pitResponse(fundamentals: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ fundamentals, asOf: Date.now(), count: Object.keys(fundamentals).length }),
  } as unknown as Response;
}

// A covered US name's payload as fundamentals-api's resolver emits it (snake_case line items + the
// provenance triple). market_cap_gbp is already the Gap-2 computed value.
const AAPL_PIT = {
  net_income: 100000, total_equity: 500000, total_debt: 300000,
  current_assets: 200000, current_liabilities: 150000, market_cap_gbp: 2.5e12,
  source: 'pit-edgar', observation_ts: 1_700_000_000_000, knowledge_ts: 1_700_100_000_000,
};

const noMint = async () => 'test-token';

describe('PitFundamentalsProvider', () => {
  it('maps a US PIT hit snake_case → camelCase FundamentalsRaw and stamps pit-edgar', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out['AAPL_US_EQ']).toEqual({
      netIncome: 100000, totalEquity: 500000, totalDebt: 300000,
      currentAssets: 200000, currentLiabilities: 150000, marketCapGbp: 2.5e12,
    });
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
    expect(yahoo.seen).toEqual([]);                       // a hit never touches Yahoo
  });

  it('calls /internal/api/fundamentals-pit with an as-of=now cutoff and an internal JWT bearer', async () => {
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));
    const mint = vi.fn(async (caller: string) => `tok-${caller}`);
    const before = Date.now();
    const p = new PitFundamentalsProvider(fakeYahoo(), BASE, fetcher as unknown as typeof fetch, mint);

    await p.fetch(['AAPL_US_EQ']);

    expect(mint).toHaveBeenCalledWith('market-data-service');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE}/internal/api/fundamentals-pit`);
    expect(url).toContain('tickers=AAPL_US_EQ');
    const asOf = Number(new URL(url).searchParams.get('asOf'));
    expect(asOf).toBeGreaterThanOrEqual(before);
    expect(asOf).toBeLessThanOrEqual(Date.now());
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-market-data-service');
  });

  it('routes a non-US (LSE *l_EQ) name straight to Yahoo without a PIT call', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['HSBAl_EQ']);

    expect(fetcher).not.toHaveBeenCalled();               // no US names ⇒ no fundamentals-api round-trip
    expect(out['HSBAl_EQ']).toBeDefined();
    expect(p.sourceOf('HSBAl_EQ')).toBe(SOURCE_YAHOO);
    expect(yahoo.seen).toEqual([['HSBAl_EQ']]);
  });

  it('falls back to Yahoo for a US PIT miss (resolved name, empty line items, source:null)', async () => {
    const yahoo = fakeYahoo();
    // The resolver returns an unresolved/miss name present with source:null and no line items.
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: AAPL_PIT,
      ZZZZ_US_EQ: { source: null, observation_ts: null, knowledge_ts: null },
    }));
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'ZZZZ_US_EQ']);

    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
    expect(p.sourceOf('ZZZZ_US_EQ')).toBe(SOURCE_YAHOO);  // miss → Yahoo
    expect(yahoo.seen).toEqual([['ZZZZ_US_EQ']]);         // only the miss was handed to Yahoo
    expect(out['ZZZZ_US_EQ']).toBeDefined();
  });

  it('degrades the whole US slice to Yahoo on a non-2xx (e.g. 503 cold warehouse), never throwing', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(out['AAPL_US_EQ']).toBeDefined();
    expect(out['MSFT_US_EQ']).toBeDefined();
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_YAHOO);
    expect(p.sourceOf('MSFT_US_EQ')).toBe(SOURCE_YAHOO);
    expect(yahoo.seen).toEqual([['AAPL_US_EQ', 'MSFT_US_EQ']]);
  });

  it('degrades to Yahoo when fundamentals-api is unreachable (fetch rejects), never throwing', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out['AAPL_US_EQ']).toBeDefined();
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_YAHOO);
    expect(yahoo.seen).toEqual([['AAPL_US_EQ']]);
  });

  it('handles a mixed batch: US hit → PIT, US miss + LSE → one Yahoo fall-back call', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: AAPL_PIT,
      ZZZZ_US_EQ: { source: null },
    }));
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'ZZZZ_US_EQ', 'HSBAl_EQ']);

    expect(Object.keys(out).sort()).toEqual(['AAPL_US_EQ', 'HSBAl_EQ', 'ZZZZ_US_EQ']);
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
    expect(p.sourceOf('ZZZZ_US_EQ')).toBe(SOURCE_YAHOO);
    expect(p.sourceOf('HSBAl_EQ')).toBe(SOURCE_YAHOO);
    expect(fetcher).toHaveBeenCalledTimes(1);             // one PIT round-trip for the US slice
    // non-US + US-miss folded into a SINGLE Yahoo call (LSE first, then the miss).
    expect(yahoo.seen).toEqual([['HSBAl_EQ', 'ZZZZ_US_EQ']]);
  });

  it('treats a missing snake_case QMJ line item as 0 (fail-closed), matching the Yahoo contract', async () => {
    const fetcher = vi.fn(async () => pitResponse({
      // A bank: no current assets/liabilities. Mapped to 0 ⇒ QMJ fail-closed downstream (no false PASS).
      JPM_US_EQ: { net_income: 50000, total_equity: 250000, total_debt: 900000, market_cap_gbp: 4e11, source: 'pit-edgar' },
    }));
    const p = new PitFundamentalsProvider(fakeYahoo(), BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['JPM_US_EQ']);

    expect(out['JPM_US_EQ']).toEqual({
      netIncome: 50000, totalEquity: 250000, totalDebt: 900000,
      currentAssets: 0, currentLiabilities: 0, marketCapGbp: 4e11,
    });
  });

  it('carries an ABSENT market_cap_gbp as null, NOT 0 (the QMJ inputs still default to 0)', async () => {
    // C1's as-of read omits `market_cap_gbp` only when the cap is genuinely uncomputable (shares
    // absent / pre-data as-of). The provider must carry that through as `null` so the scanner /
    // Research render `—`, never a fabricated £0 (the NVIDIA-£0 bug this card closes). The five QMJ
    // inputs are unaffected — a missing one stays 0 (fail-closed).
    const fetcher = vi.fn(async () => pitResponse({
      NVDA_US_EQ: {
        net_income: 100000, total_equity: 500000, total_debt: 300000,
        current_assets: 200000, current_liabilities: 150000,
        // market_cap_gbp deliberately absent (uncomputable as-of)
        source: 'pit-edgar',
      },
    }));
    const p = new PitFundamentalsProvider(fakeYahoo(), BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['NVDA_US_EQ']);

    expect(out['NVDA_US_EQ']).toEqual({
      netIncome: 100000, totalEquity: 500000, totalDebt: 300000,
      currentAssets: 200000, currentLiabilities: 150000, marketCapGbp: null,
    });
    expect(out['NVDA_US_EQ'].marketCapGbp).toBeNull();
    expect(out['NVDA_US_EQ'].marketCapGbp).not.toBe(0);   // the regression guard
    expect(p.sourceOf('NVDA_US_EQ')).toBe(SOURCE_PIT_EDGAR);   // still a hit — only the cap is absent
  });

  it('treats an explicit null market_cap_gbp the same as absent → null (never 0)', async () => {
    // The resolver may emit the key with a JSON null when the cap drops out; `num(null)` is undefined,
    // so `?? null` keeps it null — not a fabricated £0.
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: { ...AAPL_PIT, market_cap_gbp: null },
    }));
    const p = new PitFundamentalsProvider(fakeYahoo(), BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out['AAPL_US_EQ'].marketCapGbp).toBeNull();
  });

  it('passes a present market_cap_gbp through unchanged (the NVDA=£3.71T computed-cap case)', async () => {
    const fetcher = vi.fn(async () => pitResponse({
      NVDA_US_EQ: { ...AAPL_PIT, market_cap_gbp: 3_712_141_818_000 },
    }));
    const p = new PitFundamentalsProvider(fakeYahoo(), BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['NVDA_US_EQ']);

    expect(out['NVDA_US_EQ'].marketCapGbp).toBe(3_712_141_818_000);   // a real cap is never nulled
  });

  it('returns {} for an empty ticker list without any call', async () => {
    const yahoo = fakeYahoo();
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(yahoo, BASE, fetcher as unknown as typeof fetch, noMint);

    expect(await p.fetch([])).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
    expect(yahoo.seen).toEqual([]);
  });
});
