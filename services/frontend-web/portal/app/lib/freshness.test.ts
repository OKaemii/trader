import { describe, expect, it } from 'vitest'
import { computeFreshness } from './freshness'

// The "older than the last session" rule: a datum is not-live when its observation_ts predates the
// market's expected-latest-bar (the most recent completed session). Pure; pins every branch incl. the
// undeterminable cases (no market, no expected-latest), which must yield stale=null (never a guess).

const EXPECTED = { US: 1_000_000, LSE: 2_000_000 }

describe('computeFreshness', () => {
  it('marks a datum older than the last US session as not live', () => {
    const f = computeFreshness(999_999, 'AAPL_US_EQ', EXPECTED)
    expect(f).toMatchObject({ asOf: 999_999, stale: true, market: 'US', expectedLatest: 1_000_000 })
  })

  it('marks a datum at/after the last session as live', () => {
    expect(computeFreshness(1_000_000, 'AAPL_US_EQ', EXPECTED).stale).toBe(false)
    expect(computeFreshness(1_500_000, 'AAPL_US_EQ', EXPECTED).stale).toBe(false)
  })

  it('routes LSE tickers to the LSE expected-latest', () => {
    expect(computeFreshness(1_999_999, 'BARCl_EQ', EXPECTED).stale).toBe(true)   // older than LSE session
    expect(computeFreshness(2_000_001, 'BARCl_EQ', EXPECTED).stale).toBe(false)
  })

  it('returns stale=null when the ticker has no known market', () => {
    const f = computeFreshness(500, 'BTC-USD', EXPECTED)
    expect(f.stale).toBeNull()
    expect(f.market).toBe('OTHER')
    expect(f.asOf).toBe(500)
  })

  it('returns stale=null when /health published no expected-latest for the market', () => {
    expect(computeFreshness(500, 'AAPL_US_EQ', {}).stale).toBeNull()
    expect(computeFreshness(500, 'AAPL_US_EQ', { US: null }).stale).toBeNull()
    expect(computeFreshness(500, 'AAPL_US_EQ', undefined).stale).toBeNull()
  })

  it('returns asOf=null for an absent/non-finite observation_ts (and never claims a state)', () => {
    expect(computeFreshness(undefined, 'AAPL_US_EQ', EXPECTED)).toMatchObject({ asOf: null, stale: null })
    expect(computeFreshness(NaN, 'AAPL_US_EQ', EXPECTED)).toMatchObject({ asOf: null, stale: null })
    expect(computeFreshness(null, 'AAPL_US_EQ', EXPECTED).stale).toBeNull()
  })
})
