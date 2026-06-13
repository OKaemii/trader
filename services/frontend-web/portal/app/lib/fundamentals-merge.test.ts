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

// The pure merge behind the Operations per-name fundamentals state table, repointed at the harvester
// /freshness shape (epic pit-fundamentals-lake-rearchitecture, Task 21): freshness names are keyed by
// BARE symbol (no T212 ticker, no last_stored_at; gains cik / last_filed / filing_cadence), the strategy
// source stays keyed by T212 ticker, and the merge joins on the BARE symbol. No DOM (node env).

const freshness = (over: Partial<FreshnessAudit> = {}): FreshnessAudit => ({
  universe: 2,
  covered: 1,
  missing: 1,
  stale: 1,
  coverage_pct: 50,
  retirable: false,
  names: [
    {
      symbol: 'AAPL',
      cik: 320193,
      covered: true,
      newest_period_end: 1_000,
      newest_knowledge_ts: 2_000,
      last_filed: 3_000,
      filing_cadence: 'quarterly',
      staleness_days: 10,
      stale: false,
    },
    {
      symbol: 'MSFT',
      cik: 789019,
      covered: false,
      newest_period_end: null,
      newest_knowledge_ts: null,
      last_filed: null,
      filing_cadence: 'quarterly',
      staleness_days: null,
      stale: true,
    },
  ],
  ...over,
})

const source = (over: Partial<FundamentalsSource> = {}): FundamentalsSource => ({
  provider: 'pit',
  // Live provenance is pit-edgar | null post Yahoo-removal; a retired yahoo-snapshot may persist in a
  // historical stored row, kept in the fixture to prove the defensive bucket still classifies it.
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
  it('buckets pit-* → pit, a historical yahoo-* → yahoo, null/unknown → none', () => {
    expect(provenanceKind('pit-edgar')).toBe('pit')
    expect(provenanceKind('yahoo-snapshot')).toBe('yahoo')
    expect(provenanceKind(null)).toBe('none')
    expect(provenanceKind('mystery')).toBe('none')
  })
})

describe('mergeFundamentalsRows (full outer join on bare symbol)', () => {
  it('merges a name present on BOTH sides carrying both the lake + consume clocks', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    const aapl = rows.find((r) => r.symbol === 'AAPL')!
    expect(aapl).toBeDefined()
    expect(aapl.inFreshness).toBe(true)
    expect(aapl.inSource).toBe(true)
    // lake last-filed clock ≠ strategy read+built clock — the whole point of the table.
    expect(aapl.lastFiledMs).toBe(3_000)
    expect(aapl.lastReadBuiltMs).toBe(9_000)
    expect(aapl.lastFiledMs).not.toBe(aapl.lastReadBuiltMs)
    expect(aapl.fiscalPeriodMs).toBe(1_000)
    expect(aapl.availabilityMs).toBe(2_000)
    expect(aapl.filingCadence).toBe('quarterly')
    expect(aapl.source).toBe('pit-edgar')
    expect(aapl.covered).toBe(true)
  })

  it('keeps a freshness-only name (in the lake, no live read yet)', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    const msft = rows.find((r) => r.symbol === 'MSFT')!
    expect(msft.inFreshness).toBe(true)
    expect(msft.inSource).toBe(false)
    expect(msft.source).toBeNull()
    expect(msft.lastReadBuiltMs).toBeNull()
    expect(msft.stale).toBe(true)
  })

  it('keeps a source-only name (read by the strategy, absent from the audit) keyed on the bare symbol', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    // GOOG_US_EQ on the source side joins to the bare symbol GOOG.
    const goog = rows.find((r) => r.symbol === 'GOOG')!
    expect(goog.inSource).toBe(true)
    expect(goog.inFreshness).toBe(false)
    expect(goog.covered).toBeNull()
    expect(goog.lastFiledMs).toBeNull()
    expect(goog.lastReadBuiltMs).toBe(8_000)
  })

  it('joins the T212-keyed source onto the bare-keyed freshness for the same name', () => {
    // A source row keyed by the T212 ticker must merge into the freshness row keyed by the bare symbol.
    const rows = mergeFundamentalsRows(
      freshness(),
      source({ by_ticker: { AAPL_US_EQ: { source: 'pit-edgar', built_at: 12_000 } } }),
    )
    const aapl = rows.find((r) => r.symbol === 'AAPL')!
    expect(aapl.inFreshness).toBe(true)
    expect(aapl.inSource).toBe(true) // joined, not a second AAPL row
    expect(rows.filter((r) => r.symbol === 'AAPL')).toHaveLength(1)
  })

  it('yields one row per distinct bare symbol across both sides', () => {
    const rows = mergeFundamentalsRows(freshness(), source())
    expect(new Set(rows.map((r) => r.symbol)).size).toBe(rows.length)
    expect(rows.map((r) => r.symbol).sort()).toEqual(['AAPL', 'GOOG', 'MSFT'])
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

  it('sorts by symbol ascending by default', () => {
    expect(sortRows(rows, 'symbol', 'asc').map((r) => r.symbol)).toEqual(['AAPL', 'GOOG', 'MSFT'])
  })

  it('sorts by last read+built descending with nulls last', () => {
    const sorted = sortRows(rows, 'lastReadBuilt', 'desc')
    // AAPL(9000) > GOOG(8000) > MSFT(null → last)
    expect(sorted.map((r) => r.symbol)).toEqual(['AAPL', 'GOOG', 'MSFT'])
  })

  it('sorts by last filed descending with nulls last', () => {
    const sorted = sortRows(rows, 'lastFiled', 'desc')
    // AAPL(3000) first; the two nulls (GOOG, MSFT) tie-break on symbol
    expect(sorted[0].symbol).toBe('AAPL')
  })
})

describe('filterRows', () => {
  const rows = mergeFundamentalsRows(freshness(), source())

  it('"stale" keeps only stale rows', () => {
    expect(filterRows(rows, 'stale', '').map((r) => r.symbol)).toEqual(['MSFT'])
  })

  it('"missing" keeps not-covered + source-only rows', () => {
    const ids = filterRows(rows, 'missing', '').map((r) => r.symbol).sort()
    expect(ids).toEqual(['GOOG', 'MSFT'])
  })

  it('"pit" keeps only pit-sourced rows', () => {
    expect(filterRows(rows, 'pit', '').map((r) => r.symbol)).toEqual(['AAPL'])
  })

  it('text query matches the bare symbol, case-insensitive', () => {
    expect(filterRows(rows, 'all', 'aapl').map((r) => r.symbol)).toEqual(['AAPL'])
    expect(filterRows(rows, 'all', 'goog').map((r) => r.symbol)).toEqual(['GOOG'])
  })
})

describe('buildSummary', () => {
  it('rolls up the live source counts + lake coverage gate (no yahoo line — retired)', () => {
    const s = buildSummary(freshness(), source())
    expect(s.provider).toBe('pit')
    expect(s.pitServed).toBe(1)
    expect(s.nullServed).toBe(1)
    expect(s.covered).toBe(1)
    expect(s.universe).toBe(2)
    expect(s.stale).toBe(1)
    expect(s.retirable).toBe(false)
    expect(s.lastCycleMs).toBe(9_000)
    expect(s.noEdgar).toEqual([]) // no exceptions in the base fixture
    // the summary no longer carries a yahooServed field (the live cycle never serves Yahoo)
    expect('yahooServed' in s).toBe(false)
  })

  it('is all-null when both reads are null', () => {
    const s = buildSummary(null, null)
    expect(s.provider).toBeNull()
    expect(s.pitServed).toBeNull()
    expect(s.covered).toBeNull()
    expect(s.retirable).toBeNull()
    expect(s.noEdgar).toEqual([]) // always an array (panel renders without a null guard)
  })

  it('passes the no_edgar exception list through', () => {
    const s = buildSummary(
      freshness({
        no_edgar_count: 1,
        no_edgar: [{ symbol: 'TCEHY', reason: 'unsponsored ADR — files nothing with the SEC' }],
      }),
      source(),
    )
    expect(s.noEdgar).toEqual([
      { symbol: 'TCEHY', reason: 'unsponsored ADR — files nothing with the SEC' },
    ])
  })

  it('sums multiple pit buckets so a per-form source key still rolls up', () => {
    const s = buildSummary(
      null,
      source({ sources: { 'pit-edgar-10k': 2, 'pit-edgar-10q': 3, 'yahoo-snapshot': 4 } }),
    )
    expect(s.pitServed).toBe(5) // a historical yahoo bucket is not pit-served and not summed into a yahoo line
  })
})
