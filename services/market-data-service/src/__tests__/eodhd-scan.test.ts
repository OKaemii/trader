// EODHD universe scan: the pure reverse symbol map + the paginated, FX-normalised cap scan.

import { describe, it, expect, afterEach } from 'vitest';
import { fetchEodhdCapScan } from '../modules/universe/infrastructure/eodhd-scan.ts';
import { mapEodhdToT212 } from '../modules/universe/infrastructure/eodhd-symbol-map.ts';
import type { T212Instrument } from '../modules/universe/infrastructure/t212-client.ts';
import { configureEodhdClient, _setEodhdClientForTest } from '../modules/bars/infrastructure/providers/eodhd-client.ts';

function installFetch(payload: unknown): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const T212: T212Instrument[] = [
  { ticker: 'AAPL_US_EQ', name: 'Apple Inc',  shortName: 'AAPL', currencyCode: 'USD' },
  { ticker: 'HSBAl_EQ',   name: 'HSBC Hldgs', shortName: 'HSBA', currencyCode: 'GBX' },
  { ticker: 'METAl_EQ',   name: 'wrong-listing', shortName: 'META', currencyCode: 'GBX' },   // LSE META — should NOT match US META
];

describe('mapEodhdToT212', () => {
  // Native to the bare identity since Task 18: mapped rows carry `(symbol, market)`, not a T212 string.
  const idOf = (m: { symbol: string; market: string }) => `${m.symbol}|${m.market}`;

  it('maps US/LSE candidates to tradeable (symbol, market) identities and drops untradeable / unknown', () => {
    const { mapped, dropped } = mapEodhdToT212([
      { code: 'AAPL', name: 'Apple',  exchange: 'US',  marketCapGbp: 3e12, sector: 'Technology' },
      { code: 'HSBA', name: 'HSBC',   exchange: 'LSE', marketCapGbp: 1e11 },
      { code: 'NOPE', name: 'Ghost',  exchange: 'US',  marketCapGbp: 9e9 },   // not on T212
      { code: 'BRK',  name: 'Berk',   exchange: 'XETRA', marketCapGbp: 9e11 }, // unknown exchange
    ], T212);
    expect(mapped.map(idOf)).toEqual(['AAPL|US', 'HSBA|LSE']);
    expect(mapped[0]!.eodhdSymbol).toBe('AAPL.US');
    expect(mapped[0]!.sector).toBe('Technology');   // sector threaded from the screener candidate
    expect(mapped[1]!.eodhdSymbol).toBe('HSBA.LSE');
    expect(dropped).toBe(2);
  });

  // T212 renamed FB→META in 2021 (operator-confirmed); META is the canonical, orderable symbol. The
  // EODHD `META` candidate must resolve to the {META, US} identity — never the dead {FB, US} — whatever
  // shortName the broker's instrument feed currently echoes.
  it('resolves the EODHD rename (META) to the canonical {META, US} when T212 carries META', () => {
    const t212 = [{ ticker: 'META_US_EQ', name: 'Meta Platforms', shortName: 'META', currencyCode: 'USD' }];
    const { mapped } = mapEodhdToT212([{ code: 'META', name: 'Meta', exchange: 'US', marketCapGbp: 1e12 }], t212);
    expect(mapped.map(idOf)).toEqual(['META|US']);
  });

  it('still resolves META to {META, US} when the broker metadata lags (echoes legacy FB shortName)', () => {
    // The broker's instrument feed may trail the rename and still list the row under shortName FB.
    // We locate it via the legacy shortName for its name, but EMIT the canonical identity.
    const t212 = [{ ticker: 'FB_US_EQ', name: 'Meta Platforms', shortName: 'FB', currencyCode: 'USD' }];
    const { mapped } = mapEodhdToT212([{ code: 'META', name: 'Meta', exchange: 'US', marketCapGbp: 1e12 }], t212);
    expect(mapped.map(idOf)).toEqual(['META|US']);
    expect(mapped.map((m) => m.symbol)).not.toContain('FB');
    expect(mapped[0]!.name).toBe('Meta');   // EODHD candidate name preferred; instrument name is the fallback
  });
});

describe('fetchEodhdCapScan', () => {
  let spy: ReturnType<typeof installFetch> | undefined;
  afterEach(() => { spy?.restore(); spy = undefined; _setEodhdClientForTest(null); });

  it('FX-normalises cap to GBP and keeps only names >= minCapGbp', async () => {
    spy = installFetch({ data: [
      { code: 'BIG',   name: 'Big',   exchange: 'US', market_capitalization: 1e10, currency_symbol: 'USD', sector: 'Technology' }, // £8e9 → keep
      { code: 'SMALL', name: 'Small', exchange: 'US', market_capitalization: 4e9,  currency_symbol: 'USD' }, // £3.2e9 → drop
    ] });
    configureEodhdClient({ apiKey: 'k', callsPerMinute: 1000, dailyCallLimit: 1000 });
    const fx = async (amount: number, ccy: string) => (ccy === 'USD' ? amount * 0.8 : amount);
    const out = await fetchEodhdCapScan({ minCapGbp: 5e9, exchanges: ['US'], fxToGBP: fx });
    expect(out.map((c) => c.code)).toEqual(['BIG']);
    expect(out[0]!.marketCapGbp).toBeCloseTo(8e9, 0);
    expect(out[0]!.sector).toBe('Technology');   // sector carried from the EODHD screener row
    expect(spy!.calls).toHaveLength(1);   // one page (2 rows < 100) → no further pagination
  });
});
