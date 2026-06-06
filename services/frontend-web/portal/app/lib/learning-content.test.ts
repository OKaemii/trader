import { describe, expect, it } from 'vitest'
// RELATIVE import on purpose: the portal vitest config does NOT resolve the `@/` alias
// (it is a node-env unit harness), so the pure registry is imported by path.
import { interpret, METRICS, type Metric } from './learning-content'

describe('interpret — band selection', () => {
  it('picks the band by the inclusive upper bound (value <= max)', () => {
    // sharpe bands: weak<=1, good<=2, strong<=Infinity
    expect(interpret('sharpe', 0.5)?.label).toBe('weak')
    expect(interpret('sharpe', 1.5)?.label).toBe('good')
    expect(interpret('sharpe', 3)?.label).toBe('strong')
  })

  it('treats a band boundary as belonging to that (lower) band — max is inclusive', () => {
    // exactly 1.0 is still "weak" (<= 1), exactly 2.0 is still "good" (<= 2).
    expect(interpret('sharpe', 1)?.label).toBe('weak')
    expect(interpret('sharpe', 2)?.label).toBe('good')
    // a hair above the boundary tips into the next band.
    expect(interpret('sharpe', 1.0001)?.label).toBe('good')
    expect(interpret('sharpe', 2.0001)?.label).toBe('strong')
  })

  it('clamps arbitrarily-low values into the lowest band', () => {
    // a negative Sharpe is still caught by the first band (-5 <= 1).
    expect(interpret('sharpe', -5)?.label).toBe('weak')
    expect(interpret('sharpe', -5)?.tone).toBe('weak')
  })

  it('clamps arbitrarily-high values into an Infinity-capped final band', () => {
    expect(interpret('sharpe', Number.MAX_VALUE)?.label).toBe('strong')
    expect(interpret('sharpe', Infinity)?.label).toBe('strong')
  })

  it('returns the band object with both label and tone', () => {
    expect(interpret('maxDrawdown', 0.05)).toEqual({ max: 0.1, label: 'shallow', tone: 'strong' })
  })

  it('handles lower-is-better metrics (maxDrawdown) by ascending max', () => {
    expect(interpret('maxDrawdown', 0.05)?.tone).toBe('strong') // shallow → good
    expect(interpret('maxDrawdown', 0.25)?.tone).toBe('weak') // deep
    expect(interpret('maxDrawdown', 0.6)?.tone).toBe('bad') // severe
  })

  it('handles central-is-normal metrics (rsi) across both extremes', () => {
    expect(interpret('rsi', 20)?.label).toBe('oversold')
    expect(interpret('rsi', 50)?.label).toBe('neutral')
    expect(interpret('rsi', 80)?.label).toBe('overbought')
  })
})

describe('interpret — out-of-range and unknown', () => {
  it('returns null for an unknown metric id', () => {
    expect(interpret('does-not-exist', 1)).toBeNull()
    expect(interpret('', 1)).toBeNull()
  })

  it('returns null for a value beyond a bounded metric domain (RSI > 100)', () => {
    // rsi caps its final band at 100, so an out-of-domain value is "unknown", not mislabelled.
    expect(interpret('rsi', 120)).toBeNull()
  })

  it('returns null for NaN (matches no band — value <= max is always false)', () => {
    expect(interpret('sharpe', NaN)).toBeNull()
    expect(interpret('volatility', NaN)).toBeNull()
  })
})

describe('METRICS registry integrity', () => {
  const entries = Object.entries(METRICS)

  it('seeds the ten metrics the plan calls for', () => {
    for (const id of [
      'sharpe',
      'sortino',
      'maxDrawdown',
      'volatility',
      'rMultiple',
      'rsi',
      'factorExposure',
      'pbo',
      'dsr',
      'winRate',
    ]) {
      expect(METRICS[id], `missing metric ${id}`).toBeDefined()
    }
  })

  it('keys each metric by its own id', () => {
    for (const [key, metric] of entries) {
      expect(metric.id, `key ${key} disagrees with metric.id`).toBe(key)
    }
  })

  it('gives every metric a non-empty title, summary, and at least one band', () => {
    for (const [id, metric] of entries) {
      expect(metric.title, `${id} title`).toBeTruthy()
      expect(metric.summary, `${id} summary`).toBeTruthy()
      expect(metric.bands.length, `${id} bands`).toBeGreaterThan(0)
    }
  })

  it('keeps every band list sorted ascending by max (the first-match contract)', () => {
    for (const [id, metric] of entries) {
      const maxes = metric.bands.map((b) => b.max)
      const sorted = [...maxes].sort((a, b) => a - b)
      expect(maxes, `${id} bands must be ascending by max`).toEqual(sorted)
    }
  })

  it('resolves every band tone to a known token', () => {
    const tones = new Set(['bad', 'weak', 'good', 'strong'])
    for (const [id, metric] of entries) {
      for (const band of metric.bands) {
        expect(tones.has(band.tone), `${id} has unknown tone ${band.tone}`).toBe(true)
      }
    }
  })

  it('applies fmt (when present) as a pure number→string', () => {
    // percent-style metrics carry fmt; spot-check the rendering used by <Metric>/<Explain>.
    expect((METRICS.maxDrawdown.fmt as Metric['fmt'])!(0.123)).toBe('12.3%')
    expect((METRICS.winRate.fmt as Metric['fmt'])!(0.5)).toBe('50%')
    expect((METRICS.sharpe.fmt as Metric['fmt'])!(1.4234)).toBe('1.42')
  })
})
