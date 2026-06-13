// Provider symbol routing via the adapter (Task 18). The EODHD + TwelveData clients no longer carry
// their own parseT212Ticker / SYMBOL_RENAMES — they map a bare (symbol, market) identity to the
// provider's symbol, applying the adapter's market-aware FB→META rename. The legacy T212-string
// wrappers (toEodhdSymbol / toTwelveDataSymbol) are kept thin over the identity-native functions.

import { describe, it, expect } from 'vitest';
import type { TickerIdentity } from '@trader/ticker-identity';
import {
  toEodhdSymbol, toEodhdSymbolFromIdentity,
} from '../modules/bars/infrastructure/providers/eodhd-client.ts';
import {
  toTwelveDataSymbol, toTwelveDataSymbolFromIdentity,
} from '../modules/bars/infrastructure/providers/twelvedata-client.ts';

const US = (symbol: string): TickerIdentity => ({ symbol, market: 'US' });
const LSE = (symbol: string): TickerIdentity => ({ symbol, market: 'LSE' });

describe('EODHD symbol mapping (identity-native)', () => {
  it('maps a US identity to SYMBOL.US', () => {
    expect(toEodhdSymbolFromIdentity(US('AAPL'))).toBe('AAPL.US');
  });

  it('maps an LSE identity to SYMBOL.LSE', () => {
    expect(toEodhdSymbolFromIdentity(LSE('HSBA'))).toBe('HSBA.LSE');
  });

  it('applies the market-aware FB→META rename (US only)', () => {
    expect(toEodhdSymbolFromIdentity(US('FB'))).toBe('META.US');
    // The rename is US-scoped — an LSE FB (hypothetical) is not rewritten.
    expect(toEodhdSymbolFromIdentity(LSE('FB'))).toBe('FB.LSE');
  });

  it('keeps the legacy T212-string wrapper byte-identical to the prior mapping', () => {
    expect(toEodhdSymbol('AAPL_US_EQ')).toBe('AAPL.US');
    expect(toEodhdSymbol('HSBAl_EQ')).toBe('HSBA.LSE');
    expect(toEodhdSymbol('FB_US_EQ')).toBe('META.US');
  });
});

describe('TwelveData symbol mapping (identity-native)', () => {
  it('maps a US identity to country=United States', () => {
    expect(toTwelveDataSymbolFromIdentity(US('AAPL'))).toEqual({ symbol: 'AAPL', country: 'United States' });
  });

  it('maps an LSE identity to mic_code=XLON', () => {
    expect(toTwelveDataSymbolFromIdentity(LSE('HSBA'))).toEqual({ symbol: 'HSBA', micCode: 'XLON' });
  });

  it('applies the market-aware FB→META rename (US only)', () => {
    expect(toTwelveDataSymbolFromIdentity(US('FB'))).toEqual({ symbol: 'META', country: 'United States' });
    expect(toTwelveDataSymbolFromIdentity(LSE('FB'))).toEqual({ symbol: 'FB', micCode: 'XLON' });
  });

  it('keeps the legacy T212-string wrapper byte-identical to the prior mapping', () => {
    expect(toTwelveDataSymbol('AAPL_US_EQ')).toEqual({ symbol: 'AAPL', country: 'United States' });
    expect(toTwelveDataSymbol('HSBAl_EQ')).toEqual({ symbol: 'HSBA', micCode: 'XLON' });
    expect(toTwelveDataSymbol('FB_US_EQ')).toEqual({ symbol: 'META', country: 'United States' });
  });
});
