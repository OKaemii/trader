'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import {
  getBarHistory,
  getMarketDataCoverage,
  getMarketDataHealth,
  type BarInterval,
  type BarRange,
  type BarPoint,
} from '@/app/actions/admin'

const INTERVALS: BarInterval[] = ['5m', '15m', '1h', 'daily']
const RANGES:    BarRange[]    = ['30d', '60d', '90d']

interface Props {
  /** Tickers to expose in the picker. Usually the active universe. */
  tickers: string[]
  /** Optional initial selection — defaults to the first ticker in the list. */
  initialTicker?: string
}

// History explorer: pick a ticker + interval + range, see the close-price series
// market-data-service has cached for it. Reads the same admin endpoint that the
// dispatcher's drift gate and strategy-engine's warmup use, so what you see here
// is exactly what the strategy sees.
export function BarHistoryExplorer({ tickers, initialTicker }: Props) {
  const [ticker, setTicker] = useState<string>(initialTicker ?? tickers[0] ?? '')
  const [interval, setInterval] = useState<BarInterval>('daily')
  const [range, setRange] = useState<BarRange>('30d')
  const [bars, setBars] = useState<BarPoint[]>([])
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Coverage map: ticker → cached-5m-bar count. Loaded once on mount; refreshed
  // on every successful chart fetch (cheap; the endpoint is a single Mongo aggregation).
  const [coverage, setCoverage] = useState<Record<string, number>>({})
  // Next live-poll time + a tick that drives the countdown re-render every second.
  const [nextPollTs, setNextPollTs] = useState<number | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  useEffect(() => {
    getMarketDataCoverage().then((r) => { if (r.ok) setCoverage(r.data) })
    getMarketDataHealth().then((r) => { if (r.ok) setNextPollTs(r.data.next_poll_ts) })
  }, [])

  useEffect(() => {
    // 1s ticker drives the countdown. Cheap — no fetch, no allocations.
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!ticker) return
    startTransition(async () => {
      setError(null)
      const r = await getBarHistory(ticker, interval, range)
      if (r.ok) setBars(r.data.bars)
      else {
        setBars([])
        setError(r.error ?? `Failed to load (${r.status}).`)
      }
    })
  }, [ticker, interval, range])

  const minClose = bars.length > 0 ? Math.min(...bars.map((b) => b.close)) : 0
  const maxClose = bars.length > 0 ? Math.max(...bars.map((b) => b.close)) : 0
  const firstClose = bars[0]?.close
  const lastClose  = bars[bars.length - 1]?.close
  const totalReturn = firstClose && lastClose ? ((lastClose / firstClose) - 1) * 100 : null

  return (
    <section className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-gray-300">Bar history</h2>
          <p className="text-xs text-gray-500">
            Read from the shared-bars cache (Redis → Mongo on miss). Storage is always 5m;
            coarser intervals are aggregated on read.
          </p>
          {nextPollTs && (
            <p className="mt-1 text-[11px] text-gray-500">
              Next live poll: <span className="font-mono text-gray-300">{formatCountdown(nextPollTs - now)}</span>
              <span className="text-gray-600"> · {new Date(nextPollTs).toISOString().replace('T', ' ').slice(0, 16)} UTC</span>
            </p>
          )}
        </div>
        {bars.length > 0 && (
          <div className="text-right text-xs text-gray-400">
            <div>{bars.length} bars · {ticker}</div>
            {totalReturn !== null && (
              <div className={totalReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                {totalReturn >= 0 ? '+' : ''}{totalReturn.toFixed(2)}% over window
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-400">
          Ticker
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            className="min-w-[14rem] rounded border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100"
          >
            {tickers.map((t) => {
              const n = coverage[t] ?? 0
              return (
                <option key={t} value={t}>
                  {t}{n === 0 ? ' — no data' : ''}
                </option>
              )
            })}
          </select>
          {/* Inline badge mirrors the option's [no data] hint so the warning is visible
              after selection, not just while the dropdown is open. */}
          {(coverage[ticker] ?? 0) === 0 && (
            <span className="rounded border border-amber-700 bg-amber-900/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
              no data
            </span>
          )}
        </label>

        <div className="flex items-center gap-2 text-xs text-gray-400">
          Interval
          {INTERVALS.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setInterval(opt)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                interval === opt
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-gray-400">
          Range
          {RANGES.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => setRange(opt)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                range === opt
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>

        {pending && <span className="text-[10px] text-gray-500">loading…</span>}
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="h-72 w-full">
        {bars.length === 0 && !pending && !error && (
          <div className="flex h-full items-center justify-center text-xs text-gray-500">
            No bars cached for {ticker} at {interval}/{range}.
          </div>
        )}
        {bars.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={bars} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1f2937" strokeDasharray="3 3" />
              <XAxis
                dataKey="timestamp"
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                tickFormatter={(ms: number) => formatTick(ms, interval)}
                minTickGap={40}
              />
              <YAxis
                stroke="#6b7280"
                tick={{ fontSize: 10 }}
                domain={[minClose * 0.99, maxClose * 1.01]}
                tickFormatter={(v: number) => v.toFixed(2)}
                width={60}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#0b1220', border: '1px solid #1f2937', borderRadius: 4, fontSize: 12 }}
                labelStyle={{ color: '#9ca3af' }}
                // Recharts types `label` as ReactNode even when the underlying value is
                // numeric (the timestamp). Coerce explicitly so the format call is safe.
                labelFormatter={(label) => {
                  const ms = typeof label === 'number' ? label : Number(label)
                  if (!Number.isFinite(ms)) return String(label)
                  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
                }}
                formatter={(v) => {
                  const n = typeof v === 'number' ? v : Number(v)
                  return Number.isFinite(n) ? n.toFixed(4) : String(v)
                }}
              />
              <Line
                type="monotone"
                dataKey="close"
                stroke="#6366f1"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  )
}

function formatCountdown(ms: number): string {
  // Negative or near-zero: a cycle is overdue or running right now. Surface the
  // overdue state directly rather than showing "0s" — useful operator signal.
  if (ms <= 0) return 'imminent / overdue'
  const totalSec = Math.floor(ms / 1000)
  const days  = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins  = Math.floor((totalSec % 3600) / 60)
  const secs  = totalSec % 60
  if (days  > 0) return `${days}d ${hours}h ${mins}m`
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`
  if (mins  > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

function formatTick(ms: number, interval: BarInterval): string {
  const d = new Date(ms)
  if (interval === 'daily') {
    return d.toISOString().slice(5, 10)              // MM-DD
  }
  return d.toISOString().slice(5, 16).replace('T', ' ')  // MM-DD HH:MM
}
