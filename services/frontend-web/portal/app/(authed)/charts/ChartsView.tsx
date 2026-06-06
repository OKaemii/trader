'use client'

import { useState } from 'react'
import { CandlestickChart, type ChartBar } from '@/components/CandlestickChart'

const INTERVALS = ['weekly', 'daily', '4h'] as const
type Interval = (typeof INTERVALS)[number]
const RANGES: Record<Interval, string[]> = { weekly: ['1y', '2y', '5y'], daily: ['1y', '2y', '5y'], '4h': ['30d', '60d'] }

interface RawBar { observation_ts?: number; timestamp?: number; open: number; high: number; low: number; close: number; volume: number }

function toBars(raw: RawBar[]): ChartBar[] {
  return raw.map((b) => ({
    time: Math.floor((b.observation_ts ?? b.timestamp ?? 0) / 1000),
    open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }))
}

export function ChartsView({ initialTicker, initialBars }: { initialTicker: string; initialBars: ChartBar[] }) {
  const [ticker, setTicker] = useState(initialTicker)
  const [tickerInput, setTickerInput] = useState(initialTicker)
  const [interval, setInterval] = useState<Interval>('daily')
  const [range, setRange] = useState('1y')
  const [bars, setBars] = useState<ChartBar[]>(initialBars)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = async (tk: string, iv: string, rg: string) => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`/portal-api/admin/market-data/bars/${encodeURIComponent(tk)}?interval=${iv}&range=${rg}`, { cache: 'no-store' })
      const d = await res.json().catch(() => null)
      if (!res.ok || !Array.isArray(d?.bars)) { setErr(`No data for ${tk}`); setBars([]); return }
      setBars(toBars(d.bars as RawBar[]))
    } finally {
      setLoading(false)
    }
  }

  const pickInterval = (iv: Interval) => { const rg = RANGES[iv][0]!; setInterval(iv); setRange(rg); void load(ticker, iv, rg) }
  const pickRange = (rg: string) => { setRange(rg); void load(ticker, interval, rg) }
  const loadTicker = () => { const tk = tickerInput.trim().toUpperCase(); if (!tk) return; setTicker(tk); void load(tk, interval, range) }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={(e) => { e.preventDefault(); loadTicker() }} className="flex gap-1">
          <input value={tickerInput} onChange={(e) => setTickerInput(e.target.value)} className="w-44 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" placeholder="Ticker (AAPL_US_EQ)" />
          <button className="rounded bg-gray-700 px-2 py-1 text-sm hover:bg-gray-600">Load</button>
        </form>
        <div className="flex gap-1">
          {INTERVALS.map((iv) => (
            <button key={iv} onClick={() => pickInterval(iv)} className={`rounded px-2 py-1 text-sm ${interval === iv ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{iv}</button>
          ))}
        </div>
        <div className="flex gap-1">
          {RANGES[interval].map((rg) => (
            <button key={rg} onClick={() => pickRange(rg)} className={`rounded px-2 py-1 text-sm ${range === rg ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}>{rg}</button>
          ))}
        </div>
        {loading && <span className="text-xs text-gray-500">loading…</span>}
        {interval === '4h' && <span className="text-xs text-amber-400">4h is best-effort (depends on 5m freshness)</span>}
      </div>

      {err ? (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">{err}</div>
      ) : bars.length === 0 ? (
        <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">No bars for this selection.</div>
      ) : (
        <CandlestickChart key={`${ticker}-${interval}-${range}`} bars={bars} />
      )}

      <div className="text-xs text-gray-600">
        {ticker.replace(/_US_EQ$/i, '').replace(/l_EQ$/i, '.L')} · {interval} · {range} · {bars.length} bars
      </div>
    </div>
  )
}
