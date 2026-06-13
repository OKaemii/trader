import { describe, expect, it } from 'vitest'
import {
  applyRename,
  fromT212,
  identityKey,
  parseForcedAdd,
  toT212,
  type TickerIdentity,
} from './ticker-identity'

// Portal-local mirror of @trader/ticker-identity — the bare-ticker parse/produce the universe editor
// uses (epic pit-fundamentals-lake-rearchitecture, Task 21). Mirrors the upstream adapter's contract:
// the suffix rule round-trips, FB→META renames market-aware, and a non-US/LSE form is TOLERANT (null),
// not a throw (the portal renders whatever the universe contains).

describe('fromT212', () => {
  it('parses a US ticker to { symbol, US }', () => {
    expect(fromT212('GOOGL_US_EQ')).toEqual({ symbol: 'GOOGL', market: 'US' })
  })
  it('parses an LSE ticker to { symbol, LSE } (the lowercase l belongs to the suffix)', () => {
    expect(fromT212('SHELl_EQ')).toEqual({ symbol: 'SHEL', market: 'LSE' })
    expect(fromT212('SGLNl_EQ')).toEqual({ symbol: 'SGLN', market: 'LSE' })
  })
  it('returns null for a non-US/LSE form, an empty symbol, or junk (tolerant, not a throw)', () => {
    expect(fromT212('AAPL')).toBeNull() // already bare
    expect(fromT212('SOMETHING_OTHER_EQ')).toBeNull()
    expect(fromT212('_US_EQ')).toBeNull() // empty symbol
    expect(fromT212('l_EQ')).toBeNull()
    expect(fromT212('')).toBeNull()
    expect(fromT212(null)).toBeNull()
    expect(fromT212(undefined)).toBeNull()
  })
})

describe('toT212', () => {
  it('produces the broker form for US + LSE', () => {
    expect(toT212({ symbol: 'GOOGL', market: 'US' })).toBe('GOOGL_US_EQ')
    expect(toT212({ symbol: 'SHEL', market: 'LSE' })).toBe('SHELl_EQ')
  })
  it('round-trips fromT212(toT212(x)) === x for US + LSE', () => {
    const ids: TickerIdentity[] = [
      { symbol: 'AAPL', market: 'US' },
      { symbol: 'SGLN', market: 'LSE' },
    ]
    for (const id of ids) expect(fromT212(toT212(id))).toEqual(id)
  })
  it('throws on an empty symbol (guards a suffix-only string)', () => {
    expect(() => toT212({ symbol: '', market: 'US' })).toThrow()
  })
})

describe('applyRename', () => {
  it('renames US FB → META', () => {
    expect(applyRename({ symbol: 'FB', market: 'US' })).toEqual({ symbol: 'META', market: 'US' })
  })
  it('is market-aware — does NOT rename FB on LSE', () => {
    expect(applyRename({ symbol: 'FB', market: 'LSE' })).toEqual({ symbol: 'FB', market: 'LSE' })
  })
  it('leaves a non-renamed symbol unchanged', () => {
    expect(applyRename({ symbol: 'AAPL', market: 'US' })).toEqual({ symbol: 'AAPL', market: 'US' })
  })
})

describe('parseForcedAdd', () => {
  it('a bare symbol takes the market hint, upper-cased + canonical', () => {
    expect(parseForcedAdd('googl', 'US')).toEqual({ symbol: 'GOOGL', market: 'US' })
    expect(parseForcedAdd('shel', 'LSE')).toEqual({ symbol: 'SHEL', market: 'LSE' })
  })
  it('a pasted legacy T212 string — the suffix market wins over the hint', () => {
    expect(parseForcedAdd('AAPL_US_EQ', 'LSE')).toEqual({ symbol: 'AAPL', market: 'US' })
    expect(parseForcedAdd('SGLNl_EQ', 'US')).toEqual({ symbol: 'SGLN', market: 'LSE' })
    // a lower-cased US form still parses via the upper-cased retry
    expect(parseForcedAdd('aapl_us_eq', 'LSE')).toEqual({ symbol: 'AAPL', market: 'US' })
  })
  it('applies the rename (FB → META) regardless of typed shape', () => {
    expect(parseForcedAdd('fb', 'US')).toEqual({ symbol: 'META', market: 'US' })
    expect(parseForcedAdd('FB_US_EQ', 'US')).toEqual({ symbol: 'META', market: 'US' })
  })
  it('returns null on a blank entry', () => {
    expect(parseForcedAdd('', 'US')).toBeNull()
    expect(parseForcedAdd('   ', 'US')).toBeNull()
  })
})

describe('identityKey', () => {
  it('is stable + case-insensitive on symbol', () => {
    expect(identityKey({ symbol: 'AAPL', market: 'US' })).toBe('AAPL|US')
    expect(identityKey({ symbol: 'aapl', market: 'US' })).toBe('AAPL|US')
    // a cross-listed name keys distinctly per market
    expect(identityKey({ symbol: 'SHEL', market: 'US' })).not.toBe(
      identityKey({ symbol: 'SHEL', market: 'LSE' }),
    )
  })
})
