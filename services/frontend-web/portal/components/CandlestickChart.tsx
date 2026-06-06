'use client'

import { useEffect, useRef, useState } from 'react'
import type { IChartApi, Time } from 'lightweight-charts'

// Bars arrive with `time` in SECONDS (lightweight-charts' UTCTimestamp unit), chronological.
export interface ChartBar { time: number; open: number; high: number; low: number; close: number; volume: number }

// Indicators are inlined here (the portal is a standalone package and can't import
// @trader/shared-indicators); the math matches that package so chart + screener agree.
function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= period) sum -= values[i - period]!
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length <= period) return out
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!
    if (ch > 0) avgGain += ch; else avgLoss += -ch
  }
  avgGain /= period; avgLoss /= period
  const calc = (g: number, l: number) => (l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l))
  out[period] = calc(avgGain, avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!
    avgGain = (avgGain * (period - 1) + (ch > 0 ? ch : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period
    out[i] = calc(avgGain, avgLoss)
  }
  return out
}

const MAS = [
  { period: 20, color: '#60a5fa' },
  { period: 50, color: '#f59e0b' },
  { period: 200, color: '#a78bfa' },
] as const

const LAYOUT = {
  layout: { background: { color: '#111827' }, textColor: '#9ca3af' },
  grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
  timeScale: { timeVisible: true, borderColor: '#374151' },
  rightPriceScale: { borderColor: '#374151' },
}

export function CandlestickChart({ bars }: { bars: ChartBar[] }) {
  const priceRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)
  const [showMa, setShowMa] = useState<Record<number, boolean>>({ 20: true, 50: true, 200: true })

  useEffect(() => {
    if (!priceRef.current || bars.length === 0) return
    let disposed = false
    let priceChart: IChartApi | null = null
    let rsiChart: IChartApi | null = null

    void (async () => {
      const lc = await import('lightweight-charts')
      if (disposed || !priceRef.current) return
      const t = (s: number) => s as unknown as Time

      priceChart = lc.createChart(priceRef.current, { ...LAYOUT, height: 380, autoSize: true })
      const candle = priceChart.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444', borderVisible: false, wickUpColor: '#10b981', wickDownColor: '#ef4444' })
      candle.setData(bars.map((b) => ({ time: t(b.time), open: b.open, high: b.high, low: b.low, close: b.close })))

      const vol = priceChart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' } })
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
      vol.setData(bars.map((b) => ({ time: t(b.time), value: b.volume, color: b.close >= b.open ? '#10b98155' : '#ef444455' })))

      const closes = bars.map((b) => b.close)
      for (const m of MAS) {
        if (!showMa[m.period]) continue
        const line = priceChart.addLineSeries({ color: m.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        const ma = sma(closes, m.period)
        line.setData(bars.flatMap((b, i) => (ma[i] == null ? [] : [{ time: t(b.time), value: ma[i]! }])))
      }

      if (rsiRef.current) {
        rsiChart = lc.createChart(rsiRef.current, { ...LAYOUT, height: 130, autoSize: true })
        const rsiLine = rsiChart.addLineSeries({ color: '#e5e7eb', lineWidth: 1 })
        const rv = rsi(closes, 14)
        rsiLine.setData(bars.flatMap((b, i) => (rv[i] == null ? [] : [{ time: t(b.time), value: rv[i]! }])))
        rsiLine.createPriceLine({ price: 70, color: '#ef444466', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '70' })
        rsiLine.createPriceLine({ price: 30, color: '#10b98166', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '30' })

        // Keep the two time scales in lockstep.
        const pts = priceChart.timeScale(), rts = rsiChart.timeScale()
        pts.subscribeVisibleLogicalRangeChange((r) => { if (r) rts.setVisibleLogicalRange(r) })
        rts.subscribeVisibleLogicalRangeChange((r) => { if (r) pts.setVisibleLogicalRange(r) })
      }
      priceChart.timeScale().fitContent()
    })()

    return () => { disposed = true; priceChart?.remove(); rsiChart?.remove() }
  }, [bars, showMa])

  return (
    <div className="space-y-2">
      <div className="flex gap-3 text-xs">
        {MAS.map((m) => (
          <button
            key={m.period}
            onClick={() => setShowMa((s) => ({ ...s, [m.period]: !s[m.period] }))}
            className={showMa[m.period] ? 'text-white' : 'text-gray-600'}
            style={{ borderBottom: `2px solid ${m.color}` }}
          >
            SMA {m.period}
          </button>
        ))}
      </div>
      <div ref={priceRef} className="w-full rounded border border-gray-800 bg-gray-900" style={{ height: 380 }} />
      <div className="px-1 text-xs text-gray-500">RSI (14)</div>
      <div ref={rsiRef} className="w-full rounded border border-gray-800 bg-gray-900" style={{ height: 130 }} />
    </div>
  )
}
