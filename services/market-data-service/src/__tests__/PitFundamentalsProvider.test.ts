// PitFundamentalsProvider — US→PIT mapping, non-US→fail-closed (omitted), PIT-miss→omitted,
// api-down→omitted (degrade, never throw). After the Yahoo removal (epic Thread C + decision H) there
// is NO Yahoo fallback: a name with no lake fact is simply absent from `values` (the scanner then
// shows source:null / —). The fundamentals-api HTTP call is stubbed so the test is hermetic (no live
// signer, no network, no Mongo).
//
// `fetch` returns `{ values, status }`. `values` is the resolved (`hit`) map (unchanged shape);
// `status` classifies EVERY input ticker `hit | terminal | outage` so the QMJ cache can converge —
// tombstone a name that can never resolve (`terminal`) vs retry a transient seam failure (`outage`).
// The crux these tests pin: the seam HTTP outcome (an outage) is surfaced DISTINCTLY from an
// empty-but-valid body (every US name a miss → terminal).

import { describe, it, expect, vi } from 'vitest';
import {
  PitFundamentalsProvider,
  SOURCE_PIT_EDGAR,
} from '../modules/fundamentals/infrastructure/PitFundamentalsProvider.ts';

const BASE = 'http://fundamentals-api:8011';

// A fundamentals-api `{ fundamentals: { ticker: payload } }` response body builder (2xx, parseable).
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
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.values['AAPL_US_EQ']).toEqual({
      netIncome: 100000, totalEquity: 500000, totalDebt: 300000,
      currentAssets: 200000, currentLiabilities: 150000, marketCapGbp: 2.5e12,
    });
    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
  });

  it('calls /internal/api/fundamentals-pit with an as-of=now cutoff and an internal JWT bearer', async () => {
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));
    const mint = vi.fn(async (caller: string) => `tok-${caller}`);
    const before = Date.now();
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, mint);

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

  it('fail-closes a non-US (LSE *l_EQ) name: no PIT call, absent from values, no source', async () => {
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['HSBAl_EQ']);

    expect(fetcher).not.toHaveBeenCalled();               // no US names ⇒ no fundamentals-api round-trip
    expect(out.values['HSBAl_EQ']).toBeUndefined();       // fail-closed: omitted (no Yahoo substitute)
    expect(out.status['HSBAl_EQ']).toBe('terminal');      // by design — no EDGAR source exists
    expect(p.sourceOf('HSBAl_EQ')).toBeUndefined();
  });

  it('fail-closes a US PIT miss (resolved name, empty line items, source:null) — omitted, no fallback', async () => {
    // The resolver returns an unresolved/miss name present with source:null and no line items.
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: AAPL_PIT,
      ZZZZ_US_EQ: { source: null, observation_ts: null, knowledge_ts: null },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'ZZZZ_US_EQ']);

    expect(out.values['AAPL_US_EQ']).toBeDefined();
    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
    expect(out.values['ZZZZ_US_EQ']).toBeUndefined();     // miss → fail-closed (omitted)
    expect(out.status['ZZZZ_US_EQ']).toBe('terminal');    // 200 / name absent → terminal (tombstone-able)
    expect(p.sourceOf('ZZZZ_US_EQ')).toBeUndefined();
  });

  it('fail-closes the whole US slice on a non-2xx (e.g. 503 cold lake), never throwing', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(out.values['AAPL_US_EQ']).toBeUndefined();
    expect(out.values['MSFT_US_EQ']).toBeUndefined();
    expect(out.status['AAPL_US_EQ']).toBe('outage');      // seam down → outage (NOT terminal — retry)
    expect(out.status['MSFT_US_EQ']).toBe('outage');
    expect(p.sourceOf('AAPL_US_EQ')).toBeUndefined();
    expect(p.sourceOf('MSFT_US_EQ')).toBeUndefined();
  });

  it('fail-closes when fundamentals-api is unreachable (fetch rejects), never throwing', async () => {
    const fetcher = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.values['AAPL_US_EQ']).toBeUndefined();
    expect(out.status['AAPL_US_EQ']).toBe('outage');      // transport error → outage, never tombstoned
    expect(p.sourceOf('AAPL_US_EQ')).toBeUndefined();
  });

  it('handles a mixed batch: US hit → PIT (pit-edgar); US miss + LSE → omitted (one PIT round-trip)', async () => {
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: AAPL_PIT,
      ZZZZ_US_EQ: { source: null },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'ZZZZ_US_EQ', 'HSBAl_EQ']);

    expect(Object.keys(out.values)).toEqual(['AAPL_US_EQ']);   // only the US hit survives in values
    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(out.status['ZZZZ_US_EQ']).toBe('terminal');         // US 200/absent → terminal
    expect(out.status['HSBAl_EQ']).toBe('terminal');           // non-US → terminal
    expect(p.sourceOf('AAPL_US_EQ')).toBe(SOURCE_PIT_EDGAR);
    expect(p.sourceOf('ZZZZ_US_EQ')).toBeUndefined();     // miss → omitted
    expect(p.sourceOf('HSBAl_EQ')).toBeUndefined();       // non-US → fail-closed
    expect(fetcher).toHaveBeenCalledTimes(1);             // one PIT round-trip for the US slice
    // Only the two US names go into the query; the LSE name is never sent.
    const [url] = fetcher.mock.calls[0] as [string];
    expect(url).toContain('tickers=AAPL_US_EQ%2CZZZZ_US_EQ');
    expect(url).not.toContain('HSBAl_EQ');
  });

  it('treats a missing snake_case QMJ line item as 0 (fail-closed), matching the screen contract', async () => {
    const fetcher = vi.fn(async () => pitResponse({
      // A bank: no current assets/liabilities. Mapped to 0 ⇒ QMJ fail-closed downstream (no false PASS).
      JPM_US_EQ: { net_income: 50000, total_equity: 250000, total_debt: 900000, market_cap_gbp: 4e11, source: 'pit-edgar' },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['JPM_US_EQ']);

    expect(out.values['JPM_US_EQ']).toEqual({
      netIncome: 50000, totalEquity: 250000, totalDebt: 900000,
      currentAssets: 0, currentLiabilities: 0, marketCapGbp: 4e11,
    });
    expect(out.status['JPM_US_EQ']).toBe('hit');
  });

  it('carries an ABSENT market_cap_gbp as null, NOT 0 (the QMJ inputs still default to 0)', async () => {
    // The resolver omits `market_cap_gbp` only when the cap is genuinely uncomputable (shares absent /
    // pre-data as-of). The provider must carry that through as `null` so the scanner / Research render
    // `—`, never a fabricated £0 (the NVIDIA-£0 regression). The five QMJ inputs are unaffected — a
    // missing one stays 0 (fail-closed).
    const fetcher = vi.fn(async () => pitResponse({
      NVDA_US_EQ: {
        net_income: 100000, total_equity: 500000, total_debt: 300000,
        current_assets: 200000, current_liabilities: 150000,
        // market_cap_gbp deliberately absent (uncomputable as-of)
        source: 'pit-edgar',
      },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['NVDA_US_EQ']);

    expect(out.values['NVDA_US_EQ']).toEqual({
      netIncome: 100000, totalEquity: 500000, totalDebt: 300000,
      currentAssets: 200000, currentLiabilities: 150000, marketCapGbp: null,
    });
    expect(out.values['NVDA_US_EQ'].marketCapGbp).toBeNull();
    expect(out.values['NVDA_US_EQ'].marketCapGbp).not.toBe(0);   // the regression guard
    expect(p.sourceOf('NVDA_US_EQ')).toBe(SOURCE_PIT_EDGAR);   // still a hit — only the cap is absent
  });

  it('treats an explicit null market_cap_gbp the same as absent → null (never 0)', async () => {
    // The resolver may emit the key with a JSON null when the cap drops out; `num(null)` is undefined,
    // so `?? null` keeps it null — not a fabricated £0.
    const fetcher = vi.fn(async () => pitResponse({
      AAPL_US_EQ: { ...AAPL_PIT, market_cap_gbp: null },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.values['AAPL_US_EQ'].marketCapGbp).toBeNull();
  });

  it('passes a present market_cap_gbp through unchanged (the NVDA=£3.71T computed-cap case)', async () => {
    const fetcher = vi.fn(async () => pitResponse({
      NVDA_US_EQ: { ...AAPL_PIT, market_cap_gbp: 3_712_141_818_000 },
    }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['NVDA_US_EQ']);

    expect(out.values['NVDA_US_EQ'].marketCapGbp).toBe(3_712_141_818_000);   // a real cap is never nulled
  });

  it('returns empty values + empty status for an empty ticker list without any call', async () => {
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    expect(await p.fetch([])).toEqual({ values: {}, status: {} });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

// The three per-name classifications the cache converges on (RC2 seam). These pin the distinction the
// old flat-`{}` return collapsed: a definite "name absent" (terminal — tombstone it) vs an "I could
// not reach / parse the seam" (outage — retry it).
describe('PitFundamentalsProvider — per-name status classification (hit / terminal / outage)', () => {
  it('HIT: a covered US name with a resolved payload → status hit + a value', async () => {
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(out.values['AAPL_US_EQ']).toBeDefined();
  });

  it('TERMINAL (non-US): a non-US name is terminal by design — never sent, no value', async () => {
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['HSBAl_EQ', 'STANl_EQ']);

    expect(out.status['HSBAl_EQ']).toBe('terminal');
    expect(out.status['STANl_EQ']).toBe('terminal');
    expect(out.values).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();               // no US slice ⇒ no round-trip at all
  });

  it('TERMINAL (US miss): seam HTTP 200 but the US name is absent from the body → terminal', async () => {
    // The no-CIK / no-facts case (e.g. TCEHY, SPCX): the resolver doesn't even return a row for it.
    // A 200 with the name simply not present is a definite miss, distinct from a seam outage.
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT }));   // TCEHY not in the body
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'TCEHY_US_EQ']);

    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(out.status['TCEHY_US_EQ']).toBe('terminal');   // 200, name absent → terminal
    expect(out.values['TCEHY_US_EQ']).toBeUndefined();
  });

  it('TERMINAL (US miss): an empty-but-valid 200 body marks every US name terminal (not outage)', async () => {
    // The boundary case the old code conflated with an outage: a real 200 whose `fundamentals` object
    // is empty. Every requested US name was definitively absent → terminal, safe to tombstone.
    const fetcher = vi.fn(async () => pitResponse({}));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(fetcher).toHaveBeenCalledTimes(1);             // the US slice IS sent (it's a real 200)
    expect(out.status['AAPL_US_EQ']).toBe('terminal');
    expect(out.status['MSFT_US_EQ']).toBe('terminal');
    expect(out.values).toEqual({});
  });

  it('OUTAGE (non-2xx): a 503 cold-lake marks the whole US batch outage, never terminal', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'MSFT_US_EQ']);

    expect(out.status['AAPL_US_EQ']).toBe('outage');
    expect(out.status['MSFT_US_EQ']).toBe('outage');
    expect(out.values).toEqual({});
  });

  it('OUTAGE (timeout/transport): a rejected fetch marks the whole US batch outage', async () => {
    const fetcher = vi.fn(async () => { throw new Error('AbortError: timeout'); });
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.status['AAPL_US_EQ']).toBe('outage');
    expect(out.values).toEqual({});
  });

  it('OUTAGE (malformed body): a 200 whose `fundamentals` is the wrong shape is an outage, not terminal', async () => {
    // We cannot trust ANY per-name classification from a structurally-broken body, so it must NOT
    // tombstone names — it degrades to an outage (retry), exactly like a non-2xx.
    const fetcher = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ fundamentals: 'not-an-object' }),
    }) as unknown as Response);
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ']);

    expect(out.status['AAPL_US_EQ']).toBe('outage');
    expect(out.values).toEqual({});
  });

  it('MIXED: a non-US terminal coexists with a US outage in the same call', async () => {
    // The non-US name is classified terminal up front (never sent); the US slice then fails → outage.
    // Proves the two classifications are independent and both land in `status`.
    const fetcher = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response);
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const out = await p.fetch(['AAPL_US_EQ', 'HSBAl_EQ']);

    expect(out.status['HSBAl_EQ']).toBe('terminal');      // non-US → terminal regardless of the seam
    expect(out.status['AAPL_US_EQ']).toBe('outage');      // US slice seam down → outage
    expect(out.values).toEqual({});
  });

  it('every input ticker gets exactly one status entry (no name is silently dropped)', async () => {
    const fetcher = vi.fn(async () => pitResponse({ AAPL_US_EQ: AAPL_PIT, ZZZZ_US_EQ: { source: null } }));
    const p = new PitFundamentalsProvider(BASE, fetcher as unknown as typeof fetch, noMint);

    const tickers = ['AAPL_US_EQ', 'ZZZZ_US_EQ', 'HSBAl_EQ'];
    const out = await p.fetch(tickers);

    expect(Object.keys(out.status).sort()).toEqual([...tickers].sort());
    expect(out.status['AAPL_US_EQ']).toBe('hit');
    expect(out.status['ZZZZ_US_EQ']).toBe('terminal');
    expect(out.status['HSBAl_EQ']).toBe('terminal');
  });
});
