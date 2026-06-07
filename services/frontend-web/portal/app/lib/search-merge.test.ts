import { describe, it, expect } from 'vitest'
import {
  buildSearchResults,
  mergeTickers,
  mergeStrategies,
  mergeSignals,
  type UniverseBody,
  type StrategyListBody,
  type SignalsHistoryBody,
} from './search-merge'

const universe: UniverseBody = {
  activeUniverseDetailed: [
    { ticker: 'AAPL_US_EQ', name: 'Apple Inc', sector: 'Technology', market: 'US' },
    { ticker: 'AAP_US_EQ', name: 'Advance Auto Parts', sector: 'Consumer', market: 'US' },
    { ticker: 'MSFT_US_EQ', name: 'Microsoft', sector: 'Technology', market: 'US' },
    { ticker: 'BARCl_EQ', name: 'Barclays', sector: 'Financials', market: 'LSE' },
  ],
}

const strategies: StrategyListBody = {
  available: ['factor_rank_v1', 'sector_momentum_v1', 'high_velocity_v1'],
  active: 'high_velocity_v1',
}

const signals: SignalsHistoryBody = {
  signals: [
    { id: 's1', ticker: 'AAPL_US_EQ', action: 'BUY', strategy_id: 'factor_rank_v1', timestamp: 200 },
    { id: 's2', ticker: 'MSFT_US_EQ', action: 'SELL', strategy_id: 'factor_rank_v1', timestamp: 100 },
  ],
}

describe('buildSearchResults — grouped shape', () => {
  it('returns exactly { tickers, strategies, signals } with the consumer field shapes', () => {
    const out = buildSearchResults('', universe, strategies, signals)
    expect(Object.keys(out).sort()).toEqual(['signals', 'strategies', 'tickers'])

    expect(out.tickers[0]).toEqual({
      symbol: 'AAPL_US_EQ',
      name: 'Apple Inc',
      sector: 'Technology',
      market: 'US',
    })
    expect(out.strategies).toContainEqual({ id: 'high_velocity_v1', active: true })
    expect(out.strategies).toContainEqual({ id: 'factor_rank_v1', active: false })
    expect(out.signals[0]).toEqual({
      id: 's1',
      ticker: 'AAPL_US_EQ',
      action: 'BUY',
      strategy_id: 'factor_rank_v1',
      timestamp: 200,
    })
  })

  it('empty query preserves upstream order and keeps every row', () => {
    const out = buildSearchResults('', universe, strategies, signals)
    expect(out.tickers.map((t) => t.symbol)).toEqual([
      'AAPL_US_EQ',
      'AAP_US_EQ',
      'MSFT_US_EQ',
      'BARCl_EQ',
    ])
    expect(out.strategies.map((s) => s.id)).toEqual(strategies.available)
  })

  it('degrades only the failed group to [] when one upstream is null', () => {
    // Empty query keeps every row in the two live groups, so a non-empty result there
    // proves the null universe collapsed *only* its own group — not all three.
    const out = buildSearchResults('', null, strategies, signals)
    expect(out.tickers).toEqual([])
    expect(out.strategies.length).toBeGreaterThan(0) // not all groups collapse
    expect(out.signals.length).toBeGreaterThan(0)
  })

  it('all-null upstreams produce all-empty groups (no throw)', () => {
    expect(buildSearchResults('x', null, null, null)).toEqual({
      tickers: [],
      strategies: [],
      signals: [],
    })
  })
})

describe('mergeTickers — relevance rank', () => {
  it('exact symbol match outranks a prefix match', () => {
    // "aap" is a prefix of both AAPL_US_EQ and AAP_US_EQ; neither is an exact whole-symbol
    // match, so they stay in upstream order (AAPL first). Lowercasing is the caller's job
    // (buildSearchResults), so feed an already-lowered query here.
    const out = mergeTickers(universe, 'aap')
    expect(out.map((t) => t.symbol)).toEqual(['AAPL_US_EQ', 'AAP_US_EQ'])
  })

  it('prefix beats interior substring', () => {
    // Query "msft" prefixes MSFT_US_EQ (PREFIX); no other symbol contains it.
    const out = mergeTickers(universe, 'msft')
    expect(out.map((t) => t.symbol)).toEqual(['MSFT_US_EQ'])
  })

  it('matches on name when the symbol does not match', () => {
    const out = mergeTickers(universe, 'barclays')
    expect(out.map((t) => t.symbol)).toEqual(['BARCl_EQ'])
  })

  it('drops non-matching rows under a non-empty query', () => {
    const out = mergeTickers(universe, 'zzzz')
    expect(out).toEqual([])
  })

  it('falls back to bare activeUniverse + sectorMap when detailed list is absent', () => {
    const out = mergeTickers(
      { activeUniverse: ['AAPL_US_EQ', 'MSFT_US_EQ'], sectorMap: { AAPL_US_EQ: 'Technology' } },
      'aapl',
    )
    expect(out).toEqual([{ symbol: 'AAPL_US_EQ', name: '', sector: 'Technology', market: '' }])
  })

  it('skips malformed rows (missing ticker)', () => {
    const out = mergeTickers({ activeUniverseDetailed: [{ name: 'no ticker' }] }, '')
    expect(out).toEqual([])
  })
})

describe('mergeStrategies', () => {
  it('flags the active strategy and ranks an exact id match first', () => {
    const out = mergeStrategies(strategies, 'high_velocity_v1')
    expect(out[0]).toEqual({ id: 'high_velocity_v1', active: true })
  })

  it('substring query keeps matching strategies', () => {
    const out = mergeStrategies(strategies, 'momentum')
    expect(out.map((s) => s.id)).toEqual(['sector_momentum_v1'])
  })
})

describe('mergeSignals', () => {
  it('ranks an exact ticker match first', () => {
    const out = mergeSignals(signals, 'msft_us_eq')
    expect(out[0].id).toEqual('s2')
  })

  it('drops signals missing id or ticker', () => {
    const out = mergeSignals(
      { signals: [{ id: 's1' }, { ticker: 'AAPL_US_EQ' }, { id: 's2', ticker: 'MSFT_US_EQ' }] },
      '',
    )
    expect(out.map((s) => s.id)).toEqual(['s2'])
  })

  it('defaults a missing timestamp to 0', () => {
    const out = mergeSignals({ signals: [{ id: 's1', ticker: 'AAPL_US_EQ' }] }, '')
    expect(out[0].timestamp).toEqual(0)
  })
})
