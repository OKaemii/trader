import { describe, expect, it } from 'vitest'
import {
  summariseRecentResearch,
  summariseResearchRow,
  type ResearchResultRow,
} from './research-summary'

// summariseResearchRow/summariseRecentResearch distil raw /admin/api/backtest/results rows into
// the compact shape the Workspace command-center "Recent Research" snapshot renders. Tested by
// relative import because vitest does not resolve the `@/` alias.

describe('summariseResearchRow', () => {
  it('maps a full PASS row with a benchmark beat', () => {
    const row: ResearchResultRow = {
      strategy_id: 'factor_rank_v1',
      passed: true,
      oos_sharpe: 1.23456,
      run_at: '2026-06-01T00:00:00.000Z',
      engine: 'replay',
      benchmark: { beats_market: true },
    }
    expect(summariseResearchRow(row)).toEqual({
      strategy: 'factor_rank_v1',
      passed: true,
      verdict: 'PASS',
      sharpe: '1.235',
      beatsMarket: true,
      ranAt: '2026-06-01T00:00:00.000Z',
      engine: 'replay',
    })
  })

  it('renders a FAIL verdict and a benchmark miss', () => {
    const out = summariseResearchRow({
      strategy_id: 'topology_v1',
      passed: false,
      oos_sharpe: -0.5,
      benchmark: { beats_market: false },
    })
    expect(out.verdict).toBe('FAIL')
    expect(out.passed).toBe(false)
    expect(out.sharpe).toBe('-0.500')
    expect(out.beatsMarket).toBe(false)
  })

  it('treats a missing benchmark as null (not false)', () => {
    expect(summariseResearchRow({ strategy_id: 'x' }).beatsMarket).toBeNull()
    expect(summariseResearchRow({ strategy_id: 'x', benchmark: null }).beatsMarket).toBeNull()
  })

  it('shows an em dash for an absent or non-finite sharpe', () => {
    expect(summariseResearchRow({}).sharpe).toBe('—')
    expect(summariseResearchRow({ oos_sharpe: null }).sharpe).toBe('—')
    expect(summariseResearchRow({ oos_sharpe: NaN }).sharpe).toBe('—')
  })

  it('falls back to sensible defaults for missing strategy/engine', () => {
    const out = summariseResearchRow({})
    expect(out.strategy).toBe('unknown')
    expect(out.engine).toBe('replay')
    expect(out.verdict).toBe('FAIL') // passed undefined => not passed
  })
})

describe('summariseRecentResearch', () => {
  const rows: ResearchResultRow[] = Array.from({ length: 8 }, (_, i) => ({
    strategy_id: `s${i}`,
    passed: i % 2 === 0,
    oos_sharpe: i / 10,
    run_at: `2026-06-0${i + 1}T00:00:00.000Z`,
  }))

  it('returns [] for null/undefined/empty input', () => {
    expect(summariseRecentResearch(null)).toEqual([])
    expect(summariseRecentResearch(undefined)).toEqual([])
    expect(summariseRecentResearch([])).toEqual([])
  })

  it('caps to the limit, preserving (newest-first) order', () => {
    const out = summariseRecentResearch(rows, 3)
    expect(out).toHaveLength(3)
    expect(out.map((r) => r.strategy)).toEqual(['s0', 's1', 's2'])
  })

  it('defaults the limit to 5', () => {
    expect(summariseRecentResearch(rows)).toHaveLength(5)
  })

  it('returns all rows when fewer than the limit', () => {
    expect(summariseRecentResearch(rows.slice(0, 2), 5)).toHaveLength(2)
  })
})
