'use client'

import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Area, AreaChart,
} from 'recharts'
import { Explain } from '@/components/Explain'
import {
  priceReturnSeries,
  totalReturnSeries,
  drawdownSeries,
  type HistoryPoint,
} from './returns-math'

export type { HistoryPoint }

type Mode = 'returns' | 'drawdown'
type ReturnBasis = 'price' | 'total'

const fmtDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

export function ReturnsDrawdownChart({ points }: { points: HistoryPoint[] }) {
  const [mode, setMode] = useState<Mode>('returns')
  const [basis, setBasis] = useState<ReturnBasis>('total')
  const hasDividends = useMemo(() => points.some((p) => p.divPerShare > 0), [points])

  const data = useMemo(() => {
    if (points.length === 0) return []
    const cum = basis === 'total' ? totalReturnSeries(points) : priceReturnSeries(points)
    const dd = drawdownSeries(cum)
    return points.map((p, i) => ({ date: fmtDate(p.time), ret: cum[i]!, dd: dd[i]! }))
  }, [points, basis])

  // Summary stats for the header strip — current cumulative return + the worst (most negative)
  // drawdown over the window. Both read straight off the computed series.
  const last = data[data.length - 1]
  const maxDD = useMemo(() => data.reduce((m, d) => Math.min(m, d.dd), 0), [data])

  if (points.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900/40 p-6 text-sm text-gray-400">
        No price history for this symbol yet — returns and drawdowns appear once daily bars are seeded.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          <Toggle active={mode === 'returns'} onClick={() => setMode('returns')}>Returns</Toggle>
          <Toggle active={mode === 'drawdown'} onClick={() => setMode('drawdown')}>Drawdowns</Toggle>
        </div>
        <div className="flex gap-1">
          <Toggle active={basis === 'price'} onClick={() => setBasis('price')}>Price</Toggle>
          <Toggle active={basis === 'total'} onClick={() => setBasis('total')}>Total return</Toggle>
        </div>
        {!hasDividends && (
          <span className="text-xs text-gray-500">
            No dividends in window — total return equals price return.
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-gray-400">
          Cumulative{' '}
          <span className={last && last.ret >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {last ? pct(last.ret) : '—'}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-gray-400">
          Max drawdown <span className="text-red-400">{pct(maxDD)}</span>
          <Explain id="maxDrawdown" />
        </span>
      </div>

      <div className="rounded border border-gray-800 bg-gray-900 p-2">
        <ResponsiveContainer width="100%" height={260}>
          {mode === 'returns' ? (
            <LineChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
              <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} minTickGap={48} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} width={44} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff', fontSize: 12 }}
                formatter={(v) => [pct(v as number), basis === 'total' ? 'Total return' : 'Price return']}
              />
              <ReferenceLine y={0} stroke="#4b5563" />
              <Line type="monotone" dataKey="ret" stroke="#34d399" dot={false} strokeWidth={1.5} />
            </LineChart>
          ) : (
            <AreaChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
              <XAxis dataKey="date" tick={{ fill: '#6b7280', fontSize: 10 }} minTickGap={48} />
              <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} width={44} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: 'none', color: '#fff', fontSize: 12 }}
                formatter={(v) => [pct(v as number), 'Drawdown']}
              />
              <ReferenceLine y={0} stroke="#4b5563" />
              <Area type="monotone" dataKey="dd" stroke="#f87171" fill="#7f1d1d" fillOpacity={0.35} dot={false} strokeWidth={1.5} />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function Toggle({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-1 text-sm ${
        active ? 'bg-gray-700 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
      }`}
    >
      {children}
    </button>
  )
}
