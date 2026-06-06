import { describe, expect, it } from 'vitest'
import { parseMode } from './mode-parse'

// The cookie-value → Mode parsing is the one piece of branching logic in the mode layer
// (getMode/setMode are thin cookie I/O wrappers around it). Default must be 'quant' for
// every input except the exact 'beginner' string, so a missing/garbage/tampered cookie
// never silently curates surfaces away from the operator.
describe('parseMode', () => {
  it("returns 'beginner' only for the exact string 'beginner'", () => {
    expect(parseMode('beginner')).toBe('beginner')
  })

  it("returns 'quant' for the exact string 'quant'", () => {
    expect(parseMode('quant')).toBe('quant')
  })

  it("defaults to 'quant' when the cookie is absent (undefined)", () => {
    expect(parseMode(undefined)).toBe('quant')
  })

  it("defaults to 'quant' when the cookie value is null", () => {
    expect(parseMode(null)).toBe('quant')
  })

  it("defaults to 'quant' for an empty string", () => {
    expect(parseMode('')).toBe('quant')
  })

  it("defaults to 'quant' for an unknown / legacy / tampered value", () => {
    expect(parseMode('Beginner')).toBe('quant') // case-sensitive — not 'beginner'
    expect(parseMode('advanced')).toBe('quant')
    expect(parseMode('true')).toBe('quant')
  })
})
