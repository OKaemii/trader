// Bare forced-add resolution (Task 18). A forced add accepts the bare form — a bare symbol
// (`'GOOGL'`), a `{ symbol, market? }` object, or a legacy T212 string — and resolves it against the
// T212 catalog with the US-preferred cross-listing rule to a stored `(symbol, market)` identity.
// resolveForcedRemove is the no-catalog-gate twin (a removed name may be delisted).

import { describe, it, expect } from 'vitest';
import {
  indexT212ByMarket, resolveForcedAdd, resolveForcedRemove, type T212MarketIndex,
} from '../modules/universe/application/UniverseManager.ts';
import type { T212Instrument } from '../modules/universe/infrastructure/t212-client.ts';

// A catalog where GOOGL is US-only, SHEL is cross-listed (US + LSE), BP is LSE-only, and Meta is still
// echoed under its pre-rebrand shortName FB (the broker-metadata-lag case).
const CATALOG: T212Instrument[] = [
  { ticker: 'GOOGL_US_EQ', name: 'Alphabet',  shortName: 'GOOGL', currencyCode: 'USD' },
  { ticker: 'SHEL_US_EQ',  name: 'Shell US',  shortName: 'SHEL',  currencyCode: 'USD' },
  { ticker: 'SHELl_EQ',    name: 'Shell LSE', shortName: 'SHEL',  currencyCode: 'GBX' },
  { ticker: 'BPl_EQ',      name: 'BP plc',    shortName: 'BP',    currencyCode: 'GBX' },
  { ticker: 'FB_US_EQ',    name: 'Meta',      shortName: 'FB',    currencyCode: 'USD' },
];
const index: T212MarketIndex = indexT212ByMarket(CATALOG);

describe('resolveForcedAdd', () => {
  it('resolves a bare symbol to {symbol, US} (default market)', () => {
    expect(resolveForcedAdd('GOOGL', index)).toEqual({ symbol: 'GOOGL', market: 'US' });
  });

  it('lower-cases-insensitively and trims a bare symbol', () => {
    expect(resolveForcedAdd('  googl ', index)).toEqual({ symbol: 'GOOGL', market: 'US' });
  });

  it('honours an explicit market on the object form', () => {
    expect(resolveForcedAdd({ symbol: 'SHEL', market: 'LSE' }, index)).toEqual({ symbol: 'SHEL', market: 'LSE' });
    expect(resolveForcedAdd({ symbol: 'SHEL', market: 'US' }, index)).toEqual({ symbol: 'SHEL', market: 'US' });
  });

  it('prefers US for a cross-listed bare symbol (US-preferred cross-listing rule)', () => {
    expect(resolveForcedAdd('SHEL', index)).toEqual({ symbol: 'SHEL', market: 'US' });
    expect(resolveForcedAdd({ symbol: 'SHEL' }, index)).toEqual({ symbol: 'SHEL', market: 'US' });
  });

  it('falls back to LSE for an LSE-only bare symbol', () => {
    expect(resolveForcedAdd('BP', index)).toEqual({ symbol: 'BP', market: 'LSE' });
  });

  it('canonicalises FB→META and resolves via the legacy broker shortName', () => {
    // The catalog only carries the row under shortName FB; the add still lands as the canonical {META, US}.
    expect(resolveForcedAdd('FB', index)).toEqual({ symbol: 'META', market: 'US' });
    expect(resolveForcedAdd('META', index)).toEqual({ symbol: 'META', market: 'US' });
  });

  it('accepts a legacy T212 string directly (the pre-bare portal form)', () => {
    expect(resolveForcedAdd('GOOGL_US_EQ', index)).toEqual({ symbol: 'GOOGL', market: 'US' });
    expect(resolveForcedAdd('SHELl_EQ', index)).toEqual({ symbol: 'SHEL', market: 'LSE' });
  });

  it('returns null for a symbol the catalog does not carry (never a phantom add)', () => {
    expect(resolveForcedAdd('NOPE', index)).toBeNull();
    expect(resolveForcedAdd({ symbol: 'GOOGL', market: 'LSE' }, index)).toBeNull();   // not LSE-listed
  });

  it('returns null for an empty symbol or an unsupported explicit market', () => {
    expect(resolveForcedAdd('', index)).toBeNull();
    expect(resolveForcedAdd({ symbol: 'GOOGL', market: 'XETRA' }, index)).toBeNull();
  });
});

describe('resolveForcedRemove (no catalog gate)', () => {
  it('resolves a bare symbol to {symbol, US} without needing the catalog', () => {
    expect(resolveForcedRemove('TSLA')).toEqual({ symbol: 'TSLA', market: 'US' });
  });

  it('parses a legacy T212 string', () => {
    expect(resolveForcedRemove('SGLNl_EQ')).toEqual({ symbol: 'SGLN', market: 'LSE' });
    expect(resolveForcedRemove('AAPL_US_EQ')).toEqual({ symbol: 'AAPL', market: 'US' });
  });

  it('honours the object form market and canonicalises the rename', () => {
    expect(resolveForcedRemove({ symbol: 'SHEL', market: 'LSE' })).toEqual({ symbol: 'SHEL', market: 'LSE' });
    expect(resolveForcedRemove({ symbol: 'FB', market: 'US' })).toEqual({ symbol: 'META', market: 'US' });
  });

  it('returns null for an empty symbol / unsupported market', () => {
    expect(resolveForcedRemove('')).toBeNull();
    expect(resolveForcedRemove({ symbol: 'X', market: 'XETRA' })).toBeNull();
  });
});

describe('indexT212ByMarket', () => {
  it('indexes by bare shortName per market, requiring the correct listing form', () => {
    expect(index.US.GOOGL?.ticker).toBe('GOOGL_US_EQ');
    expect(index.LSE.SHEL?.ticker).toBe('SHELl_EQ');
    expect(index.US.SHEL?.ticker).toBe('SHEL_US_EQ');
    expect(index.LSE.BP?.ticker).toBe('BPl_EQ');
    expect(index.US.BP).toBeUndefined();        // BP is LSE-only
  });

  it('excludes a non-GBP/GBX `l_EQ` listing from the LSE index', () => {
    const idx = indexT212ByMarket([
      { ticker: 'XYZl_EQ', name: 'USD-quoted LSE ETF', shortName: 'XYZ', currencyCode: 'USD' },
    ]);
    expect(idx.LSE.XYZ).toBeUndefined();
  });
});
