import { describe, it, expect } from 'vitest';
import {
  Trading212TickerAdapter,
  type TickerIdentity,
} from '../adapter.ts';

const adapter = new Trading212TickerAdapter();

describe('Trading212TickerAdapter.toT212', () => {
  it('encodes a US listing as <symbol>_US_EQ', () => {
    expect(adapter.toT212({ symbol: 'GOOGL', market: 'US' })).toBe('GOOGL_US_EQ');
    expect(adapter.toT212({ symbol: 'AAPL', market: 'US' })).toBe('AAPL_US_EQ');
  });

  it('encodes an LSE listing as <symbol>l_EQ (lowercase l joined to the symbol)', () => {
    expect(adapter.toT212({ symbol: 'SHEL', market: 'LSE' })).toBe('SHELl_EQ');
    expect(adapter.toT212({ symbol: 'BP', market: 'LSE' })).toBe('BPl_EQ');
  });

  it('rejects an empty symbol rather than emitting a suffix-only string', () => {
    expect(() => adapter.toT212({ symbol: '', market: 'US' })).toThrow();
    expect(() => adapter.toT212({ symbol: '   ', market: 'LSE' })).toThrow();
  });
});

describe('Trading212TickerAdapter.fromT212', () => {
  it('parses a US ticker to { symbol, US }', () => {
    expect(adapter.fromT212('GOOGL_US_EQ')).toEqual({ symbol: 'GOOGL', market: 'US' });
  });

  it('parses an LSE ticker to { symbol, LSE } (strips the trailing l)', () => {
    expect(adapter.fromT212('SHELl_EQ')).toEqual({ symbol: 'SHEL', market: 'LSE' });
  });

  it('rejects an unsupported / OTHER market form', () => {
    // German listing, crypto, plain symbol, and a CFD-shaped suffix are all non-US/LSE
    // equities — they must throw, not coerce to a third market.
    expect(() => adapter.fromT212('SAP_DE_EQ')).toThrow();
    expect(() => adapter.fromT212('BTC_EQ_CFD')).toThrow();
    expect(() => adapter.fromT212('GOOGL')).toThrow();
    expect(() => adapter.fromT212('')).toThrow();
  });

  it('rejects a suffix with no symbol', () => {
    expect(() => adapter.fromT212('_US_EQ')).toThrow();
    expect(() => adapter.fromT212('l_EQ')).toThrow();
  });
});

describe('Trading212TickerAdapter round-trip', () => {
  const usSymbols = ['GOOGL', 'AAPL', 'MSFT', 'NVDA', 'META'];
  const lseSymbols = ['SHEL', 'BP', 'HSBA', 'VOD', 'AZN'];

  it('round-trips US identities through toT212/fromT212', () => {
    for (const symbol of usSymbols) {
      const id: TickerIdentity = { symbol, market: 'US' };
      const t212 = adapter.toT212(id);
      expect(adapter.fromT212(t212)).toEqual(id);
    }
  });

  it('round-trips LSE identities through toT212/fromT212', () => {
    for (const symbol of lseSymbols) {
      const id: TickerIdentity = { symbol, market: 'LSE' };
      const t212 = adapter.toT212(id);
      expect(adapter.fromT212(t212)).toEqual(id);
    }
  });

  it('round-trips the broker string fromT212(toT212(x)) === x for both markets', () => {
    const t212Tickers = ['GOOGL_US_EQ', 'AAPL_US_EQ', 'SHELl_EQ', 'BPl_EQ'];
    for (const t212 of t212Tickers) {
      expect(adapter.toT212(adapter.fromT212(t212))).toBe(t212);
    }
  });

  it('keeps a cross-listed symbol distinct across markets', () => {
    // SHEL trades on both NYSE and LSE; the market field disambiguates the two,
    // and neither broker form collides.
    expect(adapter.toT212({ symbol: 'SHEL', market: 'US' })).toBe('SHEL_US_EQ');
    expect(adapter.toT212({ symbol: 'SHEL', market: 'LSE' })).toBe('SHELl_EQ');
    expect(adapter.fromT212('SHEL_US_EQ')).toEqual({ symbol: 'SHEL', market: 'US' });
    expect(adapter.fromT212('SHELl_EQ')).toEqual({ symbol: 'SHEL', market: 'LSE' });
  });
});

describe('Trading212TickerAdapter.currencyOf', () => {
  it('maps US to USD and LSE to GBP', () => {
    expect(adapter.currencyOf({ symbol: 'GOOGL', market: 'US' })).toBe('USD');
    expect(adapter.currencyOf({ symbol: 'SHEL', market: 'LSE' })).toBe('GBP');
  });
});

describe('Trading212TickerAdapter.applyRename', () => {
  it('renames US FB to META', () => {
    expect(adapter.applyRename({ symbol: 'FB', market: 'US' })).toEqual({
      symbol: 'META',
      market: 'US',
    });
  });

  it('leaves a non-renamed symbol untouched (same reference semantics)', () => {
    const id: TickerIdentity = { symbol: 'GOOGL', market: 'US' };
    expect(adapter.applyRename(id)).toEqual(id);
  });

  it('is market-aware: FB on LSE is not the US rebrand and is left untouched', () => {
    expect(adapter.applyRename({ symbol: 'FB', market: 'LSE' })).toEqual({
      symbol: 'FB',
      market: 'LSE',
    });
  });

  it('preserves the market when renaming', () => {
    const renamed = adapter.applyRename({ symbol: 'FB', market: 'US' });
    expect(renamed.market).toBe('US');
  });

  it('round-trips a renamed symbol to the canonical T212 form', () => {
    const renamed = adapter.applyRename({ symbol: 'FB', market: 'US' });
    expect(adapter.toT212(renamed)).toBe('META_US_EQ');
  });
});
