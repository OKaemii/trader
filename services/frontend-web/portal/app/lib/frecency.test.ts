import { describe, expect, it } from 'vitest'
import {
  frecencyScore,
  parseRecents,
  rankRecents,
  touchRecents,
  RECENTS_MAX,
  type RecentEntity,
} from './frecency'

// Pure frecency contract for the ⌘K entity shortlist (research-trading-os Task 21).
// The localStorage shell (loadRecents/recordRecent) is exercised by the component
// test; here we lock the ranking + dedupe + parse behaviour in plain vitest.

const DAY = 24 * 60 * 60 * 1000

function entity(over: Partial<RecentEntity>): RecentEntity {
  return { kind: 'ticker', id: 'X', label: 'X', count: 1, lastTs: 0, ...over }
}

describe('frecencyScore', () => {
  it('rewards higher count at the same recency', () => {
    const now = 1_000_000
    const a = frecencyScore({ count: 1, lastTs: now }, now)
    const b = frecencyScore({ count: 5, lastTs: now }, now)
    expect(b).toBeGreaterThan(a)
  })

  it('decays with age (older < newer at the same count)', () => {
    const now = 10 * DAY
    const fresh = frecencyScore({ count: 3, lastTs: now }, now)
    const stale = frecencyScore({ count: 3, lastTs: now - 6 * DAY }, now)
    expect(fresh).toBeGreaterThan(stale)
  })

  it('a high-count old entry can still beat a low-count fresh one within the half-life', () => {
    const now = 5 * DAY
    const oldHeavy = frecencyScore({ count: 10, lastTs: now - DAY }, now)
    const freshLight = frecencyScore({ count: 1, lastTs: now }, now)
    expect(oldHeavy).toBeGreaterThan(freshLight)
  })
})

describe('rankRecents', () => {
  it('orders by frecency, most-frecent first, and truncates to the limit', () => {
    const now = 3 * DAY
    const recents: RecentEntity[] = [
      entity({ id: 'A', count: 1, lastTs: now - 2 * DAY }),
      entity({ id: 'B', count: 5, lastTs: now }),
      entity({ id: 'C', count: 1, lastTs: now }),
    ]
    const ranked = rankRecents(recents, now, 2)
    expect(ranked.map((e) => e.id)).toEqual(['B', 'C'])
  })

  it('does not mutate the input list', () => {
    const recents: RecentEntity[] = [entity({ id: 'A' }), entity({ id: 'B' })]
    const before = recents.map((e) => e.id)
    rankRecents(recents, Date.now())
    expect(recents.map((e) => e.id)).toEqual(before)
  })
})

describe('touchRecents', () => {
  it('inserts a new entry with count 1', () => {
    const now = 100
    const next = touchRecents([], { kind: 'ticker', id: 'AAPL', label: 'AAPL', sublabel: 'Apple' }, now)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ kind: 'ticker', id: 'AAPL', count: 1, lastTs: 100, sublabel: 'Apple' })
  })

  it('bumps count + lastTs and refreshes label on a repeat (kind,id)', () => {
    const seed: RecentEntity[] = [entity({ kind: 'ticker', id: 'AAPL', label: 'old', count: 2, lastTs: 1 })]
    const next = touchRecents(seed, { kind: 'ticker', id: 'AAPL', label: 'new', sublabel: 'Apple' }, 500)
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'AAPL', count: 3, lastTs: 500, label: 'new', sublabel: 'Apple' })
  })

  it('treats the same id under a different kind as a distinct entry', () => {
    const seed: RecentEntity[] = [entity({ kind: 'ticker', id: 'AAPL' })]
    const next = touchRecents(seed, { kind: 'signal', id: 'AAPL', label: 'AAPL BUY' }, 10)
    expect(next).toHaveLength(2)
  })

  it('does not mutate the input list', () => {
    const seed: RecentEntity[] = [entity({ id: 'AAPL', count: 1 })]
    touchRecents(seed, { kind: 'ticker', id: 'AAPL', label: 'AAPL' }, 10)
    expect(seed[0].count).toBe(1)
  })

  it('caps the stored list at RECENTS_MAX, dropping the coldest entries', () => {
    const now = 1_000_000
    // Seed MAX entries, all older/colder than the fresh hit added below.
    let list: RecentEntity[] = Array.from({ length: RECENTS_MAX }, (_, i) =>
      entity({ id: `T${i}`, count: 1, lastTs: now - (i + 1) * DAY }),
    )
    list = touchRecents(list, { kind: 'ticker', id: 'FRESH', label: 'FRESH' }, now)
    expect(list).toHaveLength(RECENTS_MAX)
    expect(list.some((e) => e.id === 'FRESH')).toBe(true)
    // The coldest seed (largest age) is evicted.
    expect(list.some((e) => e.id === `T${RECENTS_MAX - 1}`)).toBe(false)
  })
})

describe('parseRecents', () => {
  it('returns [] for null / empty / malformed JSON', () => {
    expect(parseRecents(null)).toEqual([])
    expect(parseRecents('')).toEqual([])
    expect(parseRecents('{not json')).toEqual([])
    expect(parseRecents('{"a":1}')).toEqual([]) // not an array
  })

  it('keeps valid entries and drops ones missing required fields', () => {
    const raw = JSON.stringify([
      { kind: 'ticker', id: 'AAPL', label: 'AAPL', count: 2, lastTs: 5 },
      { kind: 'bogus', id: 'X', label: 'X' }, // bad kind
      { kind: 'signal', label: 'no-id' }, // missing id
      { kind: 'strategy', id: 'factor_rank_v1', label: 'factor_rank_v1' }, // defaults count/lastTs
    ])
    const out = parseRecents(raw)
    expect(out.map((e) => e.id)).toEqual(['AAPL', 'factor_rank_v1'])
    expect(out[1]).toMatchObject({ count: 1, lastTs: 0 })
  })
})
