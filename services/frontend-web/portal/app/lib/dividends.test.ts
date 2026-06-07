import { describe, it, expect } from 'vitest'
import { trailing12mDividend, sortDividendsDesc, type DividendRecord } from './dividends'

const asOf = Date.parse('2026-06-01')

describe('trailing12mDividend', () => {
  it('sums only ex-dates within the trailing year', () => {
    const divs: DividendRecord[] = [
      { date: '2026-05-01', valuePerShare: 0.25, currency: 'USD' },
      { date: '2026-02-01', valuePerShare: 0.25, currency: 'USD' },
      { date: '2025-11-01', valuePerShare: 0.24, currency: 'USD' },
      { date: '2025-08-01', valuePerShare: 0.24, currency: 'USD' },
      { date: '2024-08-01', valuePerShare: 0.22, currency: 'USD' }, // >1y — excluded
    ]
    const r = trailing12mDividend(divs, asOf)
    expect(r.count).toBe(4)
    expect(r.total).toBeCloseTo(0.98, 10)
    expect(r.currency).toBe('USD')
  })

  it('reports the most-recent qualifying payment currency regardless of input order', () => {
    const divs: DividendRecord[] = [
      { date: '2025-09-01', valuePerShare: 1.0, currency: 'GBP' },
      { date: '2026-03-01', valuePerShare: 1.1, currency: 'GBP' },
    ]
    expect(trailing12mDividend(divs, asOf).currency).toBe('GBP')
  })

  it('excludes future-dated ex-dates (after asOf)', () => {
    const divs: DividendRecord[] = [
      { date: '2026-09-01', valuePerShare: 0.3 }, // future
      { date: '2026-03-01', valuePerShare: 0.3 },
    ]
    const r = trailing12mDividend(divs, asOf)
    expect(r.count).toBe(1)
    expect(r.total).toBeCloseTo(0.3, 10)
  })

  it('skips non-finite values and unparseable dates without throwing', () => {
    const divs: DividendRecord[] = [
      { date: '2026-04-01', valuePerShare: Number.NaN },
      { date: 'not-a-date', valuePerShare: 0.5 },
      { date: '2026-04-01', valuePerShare: 0.4 },
    ]
    const r = trailing12mDividend(divs, asOf)
    expect(r.total).toBeCloseTo(0.4, 10)
    expect(r.count).toBe(2) // the NaN-value row still counts as a payment in-window; its value is 0
  })

  it('returns a zero total and no currency for a non-payer', () => {
    const r = trailing12mDividend([], asOf)
    expect(r).toEqual({ total: 0, currency: undefined, count: 0 })
  })
})

describe('sortDividendsDesc', () => {
  it('orders most-recent ex-date first and does not mutate the input', () => {
    const divs: DividendRecord[] = [
      { date: '2025-01-01', valuePerShare: 1 },
      { date: '2026-01-01', valuePerShare: 1 },
      { date: '2025-06-01', valuePerShare: 1 },
    ]
    const sorted = sortDividendsDesc(divs)
    expect(sorted.map((d) => d.date)).toEqual(['2026-01-01', '2025-06-01', '2025-01-01'])
    expect(divs[0].date).toBe('2025-01-01') // original untouched
  })
})
