import { describe, expect, it } from 'vitest'
// RELATIVE import on purpose: the portal vitest config does NOT resolve the `@/` alias
// (it is a node-env unit harness), so the pure registry is imported by path.
import { DEPTHS, interpret, maxDepth, METRICS, type Metric } from './learning-content'

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

describe('research metrics broadened for the epic (Task 32 §F)', () => {
  it('adds the research metrics the epic surfaces', () => {
    for (const id of [
      'factorPercentile',
      'momentum',
      'quality',
      'value',
      'volatilityFactor',
      'inclusion',
      'contribution',
      'breadth',
      'hhi',
    ]) {
      expect(METRICS[id], `missing research metric ${id}`).toBeDefined()
    }
  })

  it('interprets the cross-sectional factor z-scores around the universe mean', () => {
    // central/positive-is-leading: a z of 0 is average, +2 leads, −2 lags.
    expect(interpret('momentum', -2)?.label).toBe('lagging')
    expect(interpret('momentum', 0)?.label).toBe('average')
    expect(interpret('momentum', 2)?.label).toBe('strong')
    expect(interpret('quality', 2)?.tone).toBe('strong')
    expect(interpret('value', -2)?.label).toBe('expensive')
  })

  it('reads factorPercentile as a 0–1 rank (top of book scores best)', () => {
    expect(interpret('factorPercentile', 0.2)?.label).toBe('low')
    expect(interpret('factorPercentile', 0.95)?.label).toBe('top')
    // bounded ∈ [0,1]: a value past the domain is unknown, not mislabelled.
    expect(interpret('factorPercentile', 1.2)).toBeNull()
  })

  it('reads lower-is-better concentration/inclusion correctly', () => {
    // HHI: an equal-weight 20-name book sits near 0.05 → diversified; piling in → top-heavy.
    expect(interpret('hhi', 0.05)?.tone).toBe('strong')
    expect(interpret('hhi', 0.5)?.label).toBe('top-heavy')
    // inclusion: a narrow funnel is the selective (good) end.
    expect(interpret('inclusion', 0.03)?.label).toBe('very narrow')
    expect(interpret('inclusion', 0.9)?.tone).toBe('weak')
  })

  it('treats contribution as signed (detractors are negative)', () => {
    expect(interpret('contribution', -0.2)?.label).toBe('detractor')
    expect(interpret('contribution', -0.2)?.tone).toBe('bad')
    expect(interpret('contribution', 0.2)?.label).toBe('major driver')
  })
})

describe('progressive disclosure — layered registry (Task 32 §F)', () => {
  const entries = Object.entries(METRICS)

  it('exposes the depth ladder summary → factors → detail', () => {
    expect(DEPTHS).toEqual(['summary', 'factors', 'detail'])
  })

  it('maxDepth reports the deepest populated layer (0..2)', () => {
    // sharpe carries both factors and detail → depth 2.
    expect(maxDepth('sharpe')).toBe(2)
    // every broadened metric ships full three-layer copy.
    expect(maxDepth('hhi')).toBe(2)
    expect(maxDepth('breadth')).toBe(2)
  })

  it('returns 0 for an unknown id (degrades silently, like interpret)', () => {
    expect(maxDepth('does-not-exist')).toBe(0)
    expect(maxDepth('')).toBe(0)
  })

  it('keeps the layer ordering invariant: a detail layer implies a factors layer', () => {
    // The component reveals factors at depth 1 before detail at depth 2; a metric that
    // skipped the middle rung would show "Full detail" with no "Key factors" before it.
    for (const [id, metric] of entries) {
      if (metric.detail) {
        expect(metric.factors && metric.factors.length > 0, `${id} has detail but no factors`).toBe(true)
      }
    }
  })

  it('agrees maxDepth with the populated fields for every metric', () => {
    for (const [id, metric] of entries) {
      const expected = metric.detail ? 2 : metric.factors && metric.factors.length > 0 ? 1 : 0
      expect(maxDepth(id), `${id} maxDepth disagrees with its layers`).toBe(expected)
    }
  })

  it('gives every factors entry and detail non-empty copy when present', () => {
    for (const [id, metric] of entries) {
      if (metric.factors) {
        for (const factor of metric.factors) {
          expect(factor, `${id} has an empty factor bullet`).toBeTruthy()
        }
      }
      if (metric.detail) expect(metric.detail.length, `${id} detail`).toBeGreaterThan(0)
    }
  })
})
