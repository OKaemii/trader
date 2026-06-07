import { describe, it, expect } from 'vitest'
import {
  priceReturnSeries,
  totalReturnSeries,
  drawdownSeries,
  type HistoryPoint,
} from './returns-math'

const pt = (close: number, divPerShare = 0, time = 0): HistoryPoint => ({ time, close, divPerShare })

describe('priceReturnSeries', () => {
  it('re-indexes to 0% at the first point', () => {
    const s = priceReturnSeries([pt(100), pt(110), pt(90)])
    expect(s[0]).toBe(0)
    expect(s[1]).toBeCloseTo(0.1, 10)
    expect(s[2]).toBeCloseTo(-0.1, 10)
  })

  it('degrades to all-zeros when the base close is non-positive', () => {
    expect(priceReturnSeries([pt(0), pt(50)])).toEqual([0, 0])
  })

  it('returns [] for an empty series', () => {
    expect(priceReturnSeries([])).toEqual([])
  })
})

describe('totalReturnSeries', () => {
  it('equals the price return exactly when there are no dividends', () => {
    const pts = [pt(100), pt(110), pt(121)]
    const tr = totalReturnSeries(pts)
    const pr = priceReturnSeries(pts)
    for (let i = 0; i < pts.length; i++) expect(tr[i]).toBeCloseTo(pr[i]!, 10)
  })

  it('reinvests an ex-date dividend at that day close, lifting total above price return', () => {
    // Flat price 100 → 100, with a 2.0/share dividend on day 2. Price return = 0%; total return =
    // the reinvestment growth (1 + 2/100) − 1 = +2%.
    const tr = totalReturnSeries([pt(100), pt(100, 2)])
    expect(tr[0]).toBe(0)
    expect(tr[1]).toBeCloseTo(0.02, 10)
  })

  it('compounds price growth and dividend reinvestment multiplicatively', () => {
    // Day1 100 → Day2 110 (+10%) with a 5.5/share dividend reinvested at 110:
    //   wealth = 1.10 · (1 + 5.5/110) = 1.10 · 1.05 = 1.155 → +15.5%.
    const tr = totalReturnSeries([pt(100), pt(110, 5.5)])
    expect(tr[1]).toBeCloseTo(0.155, 10)
  })
})

describe('drawdownSeries', () => {
  it('is 0 while making new highs and negative below the running peak', () => {
    // cum returns: 0, +10%, +4.5%. Peak wealth 1.10 on day 2; day 3 wealth 1.045 →
    // drawdown = 1.045 / 1.10 − 1 ≈ −5.0%.
    const dd = drawdownSeries([0, 0.1, 0.045])
    expect(dd[0]).toBe(0)
    expect(dd[1]).toBe(0)
    expect(dd[2]).toBeCloseTo(1.045 / 1.1 - 1, 10)
    expect(dd[2]).toBeLessThan(0)
  })

  it('recovers to 0 once the wealth index exceeds the prior peak', () => {
    const dd = drawdownSeries([0, -0.2, 0.3])
    expect(dd[1]).toBeLessThan(0)
    expect(dd[2]).toBe(0)
  })
})
