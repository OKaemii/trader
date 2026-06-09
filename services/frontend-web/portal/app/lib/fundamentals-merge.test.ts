import { describe, expect, it } from 'vitest'
import {
  buildSummary,
  filterRows,
  mergeFundamentalsRows,
  provenanceKind,
  sortRows,
  type FreshnessAudit,
  type FundamentalsSource,
} from './fundamentals-merge'

// card 149 — the pure merge behind the Operations per-ticker fundamentals state table. Pins the
// full-outer-join semantics (both sides kept), BOTH clocks per row, the summary roll-up, and the
// sort/filter helpers. No DOM (node env).

const freshness = (over: Partial<FreshnessAudit> = {}): FreshnessAudit => ({
  universe: 2,
  covered: 1,
  missing: 1,
  stale: 1,
  coverage_pct: 50,
  retirable: false,
  last_ingest_run: { state: 'done', finished_at_ms: 5_000 },
  names: [
    {
      symbol: 'AAPL',
      ticker: 'AAPL_US_EQ',
      instrument_id: 1,
      covered: true,
      newest_period_end: 1_000,
      newest_knowledge_ts: 2_000,
      last_stored_at: 3_000,
      staleness_days: 10,
      stale: false,
    },
    {
      symbol: 'MSFT',
      ticker: 'MSFT_US_EQ',
      instrument_id: 2,
      covered: false,
      newest_period_end: null,
      newest_knowledge_ts: null,
      last_stored_at: null,
      staleness_days: null,
      stale: true,
    },
  ],
  ...over,
})

const source = (over: Partial<FundamentalsSource> = {}): FundamentalsSource => ({
  provider: 'pit',
  sources: { 'pit-edgar': 1, 'yahoo-snapshot': 1, null: 1 },
  by_ticker: {
    AAPL_US_EQ: { source: 'pit-edgar', built_at: 9_000 },
    // GOOG is source-only (the strategy read it, the freshness audit didn't surface it).
    GOOG_US_EQ: { source: 'yahoo-snapshot', built_at: 8_000 },
  },
  pit_served: 1,
  last_cycle_ts: 9_000,
  ...over,
})

describe('provenanceKind', () => {
  it('buckets pit-* → pit, yahoo-* → yahoo, null/unknown → none', () => {
    expect(provenanceKind('pit-edgar')).toBe('pit')
    expect(provenanceKind('yahoo-snapshot')).toBe('yahoo')
    expect(provenanceKind(null)).toBe('none')
    expect(provenanceKind('mystery')).toBe('none')
  })
})

describe('mergeFundamentalsRows (full outer join on ticker)', () => {
  it('merges a name present on BOTH sides carrying BOTH clocks', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    const aapl = rows.find((r) => r.ticker === 'AAPL_US_EQ')!
    expect(aapl).toBeDefined()
    expect(aapl.inFreshness).toBe(true)
    expect(aapl.inSource).toBe(true)
    // warehouse clock (ingest) ≠ strategy clock (read+built) — the whole point of the table.
    expect(aapl.lastStoredMs).toBe(3_000)
    expect(aapl.lastReadBuiltMs).toBe(9_000)
    expect(aapl.lastStoredMs).not.toBe(aapl.lastReadBuiltMs)
    expect(aapl.fiscalPeriodMs).toBe(1_000)
    expect(aapl.availabilityMs).toBe(2_000)
    expect(aapl.source).toBe('pit-edgar')
    expect(aapl.covered).toBe(true)
  })

  it('keeps a freshness-only name (in the warehouse, no live read yet)', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    const msft = rows.find((r) => r.ticker === 'MSFT_US_EQ')!
    expect(msft.inFreshness).toBe(true)
    expect(msft.inSource).toBe(false)
    expect(msft.source).toBeNull()
    expect(msft.lastReadBuiltMs).toBeNull()
    expect(msft.stale).toBe(true)
  })

  it('keeps a source-only name (read by the strategy, absent from the audit)', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    const goog = rows.find((r) => r.ticker === 'GOOG_US_EQ')!
    expect(goog.inSource).toBe(true)
    expect(goog.inFreshness).toBe(false)
    expect(goog.covered).toBeNull()
    expect(goog.lastStoredMs).toBeNull()
    expect(goog.lastReadBuiltMs).toBe(8_000)
    expect(goog.symbol).toBeNull() // no warehouse row to read the bare symbol from
  })

  it('yields one row per distinct ticker across both sides', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    expect(new Set(rows.map((r) => r.ticker)).size).toBe(rows.length)
    expect(rows.map((r) => r.ticker).sort()).toEqual(['AAPL_US_EQ', 'GOOG_US_EQ', 'MSFT_US_EQ'])
  })

  it('returns [] when both reads are null (cold/unreachable)', () => {
    expect(mergeFundamentalsRows(null, null)).toEqual([])
  })

  it('works with only freshness (source cold)', () => {
    const rows = mergeFundamentalsRows(freshness(), null)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.inSource)).toBe(true)
  })
})

describe('sortRows', () => {
  const rows = mergeFundamentalsRows(freshness(), source())

  it('sorts by ticker ascending by default', () => {
    expect(sortRows(rows, 'ticker', 'asc').map((r) => r.ticker)).toEqual([
      'AAPL_US_EQ',
      'GOOG_US_EQ',
      'MSFT_US_EQ',
    ])
  })

  it('sorts by last read+built descending with nulls last', () => {
    const sorted = sortRows(rows, 'lastReadBuilt', 'desc')
    // AAPL(9000) > GOOG(8000) > MSFT(null → last)
    expect(sorted.map((r) => r.ticker)).toEqual(['AAPL_US_EQ', 'GOOG_US_EQ', 'MSFT_US_EQ'])
  })

  it('sorts by last stored descending with nulls last', () => {
    const sorted = sortRows(rows, 'lastStored', 'desc')
    // AAPL(3000) first; the two nulls (GOOG, MSFT) tie-break on ticker
    expect(sorted[0].ticker).toBe('AAPL_US_EQ')
  })
})

describe('filterRows', () => {
  const rows = mergeFundamentalsRows(freshness(), source())

  it('"stale" keeps only stale rows', () => {
    expect(filterRows(rows, 'stale', '').map((r) => r.ticker)).toEqual(['MSFT_US_EQ'])
  })

  it('"missing" keeps not-covered + source-only rows', () => {
    const ids = filterRows(rows, 'missing', '').map((r) => r.ticker).sort()
    expect(ids).toEqual(['GOOG_US_EQ', 'MSFT_US_EQ'])
  })

  it('"pit" keeps only pit-sourced rows', () => {
    expect(filterRows(rows, 'pit', '').map((r) => r.ticker)).toEqual(['AAPL_US_EQ'])
  })

  it('"yahoo" keeps only yahoo-sourced rows', () => {
    expect(filterRows(rows, 'yahoo', '').map((r) => r.ticker)).toEqual(['GOOG_US_EQ'])
  })

  it('text query matches ticker or symbol, case-insensitive', () => {
    expect(filterRows(rows, 'all', 'aapl').map((r) => r.ticker)).toEqual(['AAPL_US_EQ'])
    expect(filterRows(rows, 'all', 'goog').map((r) => r.ticker)).toEqual(['GOOG_US_EQ'])
  })
})

describe('buildSummary', () => {
  it('rolls up the live source counts + warehouse coverage gate', () => {
    const s = buildSummary(freshness(), source())
    expect(s.provider).toBe('pit')
    expect(s.pitServed).toBe(1)
    expect(s.yahooServed).toBe(1)
    expect(s.nullServed).toBe(1)
    expect(s.covered).toBe(1)
    expect(s.universe).toBe(2)
    expect(s.stale).toBe(1)
    expect(s.retirable).toBe(false)
    expect(s.lastIngestRunMs).toBe(5_000)
    expect(s.lastIngestRunState).toBe('done')
  })

  it('is all-null when both reads are null', () => {
    const s = buildSummary(null, null)
    expect(s.provider).toBeNull()
    expect(s.pitServed).toBeNull()
    expect(s.covered).toBeNull()
    expect(s.retirable).toBeNull()
  })

  it('sums multiple pit/yahoo buckets so a per-form source key still rolls up', () => {
    const s = buildSummary(
      null,
      source({ sources: { 'pit-edgar-10k': 2, 'pit-edgar-10q': 3, 'yahoo-snapshot': 4 } }),
    )
    expect(s.pitServed).toBe(5)
    expect(s.yahooServed).toBe(4)
  })
})
