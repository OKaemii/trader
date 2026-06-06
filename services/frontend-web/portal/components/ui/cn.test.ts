import { describe, expect, it } from 'vitest'
import { cn } from './cn'

// Proves the vitest harness runs (Task 1) and exercises the cn() join used by every
// ui/* primitive to merge a caller's className onto the dark-theme defaults.
describe('cn', () => {
  it('joins truthy class strings with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('drops falsey values so conditional classes collapse cleanly', () => {
    const active = false
    const disabled = true
    expect(cn('base', active && 'is-active', disabled && 'is-disabled', null, undefined)).toBe(
      'base is-disabled',
    )
  })

  it('returns an empty string when nothing is truthy', () => {
    expect(cn(false, null, undefined)).toBe('')
  })
})
