import { describe, expect, it } from 'vitest'
import { resolveTab, type WorkspaceTab } from './tabs'

// resolveTab is the shared fallback used by every workspace page (server) and
// WorkspaceTabs (client) to decide the active tab from `?tab=`. The contract the
// six workspace cards rely on: a known key passes through; anything else (unknown
// value, or an absent param) collapses to the FIRST tab.
const TABS: ReadonlyArray<WorkspaceTab> = [
  { key: 'positions', label: 'Positions' },
  { key: 'performance', label: 'Performance' },
  { key: 'trips', label: 'Circuit Trips' },
]

describe('resolveTab', () => {
  it('returns a known tab key unchanged', () => {
    expect(resolveTab(TABS, 'performance')).toBe('performance')
  })

  it('falls back to the first tab for an unknown key', () => {
    expect(resolveTab(TABS, 'does-not-exist')).toBe('positions')
  })

  it('falls back to the first tab when the param is absent (undefined)', () => {
    expect(resolveTab(TABS, undefined)).toBe('positions')
  })

  it('falls back to the first tab when the param is null', () => {
    // useSearchParams().get() returns null for a missing param.
    expect(resolveTab(TABS, null)).toBe('positions')
  })

  it('falls back to the first tab for an empty string (?tab=)', () => {
    expect(resolveTab(TABS, '')).toBe('positions')
  })

  it('returns undefined when there are no tabs to fall back to', () => {
    expect(resolveTab([], 'anything')).toBeUndefined()
  })
})
