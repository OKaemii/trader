'use client'

import { useEffect, useState, type CSSProperties } from 'react'

export interface SectorPerf {
  ticker: string
  sector: string
  weekReturns: number[]
  latest: number | null
  trailing4w: number | null
  trailing13w: number | null
}

function pct(r: number | null): string {
  return r == null ? '—' : `${r >= 0 ? '+' : ''}${(r * 100).toFixed(1)}%`
}

// Green for positive, red for negative, saturating at ±5% weekly / ±15% trailing.
function cell(r: number | null, sat = 0.05): CSSProperties {
  if (r == null) return { color: '#6b7280' }
  const mag = Math.min(1, Math.abs(r) / sat)
  const alpha = 0.12 + 0.6 * mag
  return { backgroundColor: r >= 0 ? `rgba(16,185,129,${alpha})` : `rgba(239,68,68,${alpha})` }
}

export function SectorHeatmap({ initial, weeks }: { initial: SectorPerf[]; weeks: number }) {
  const [rows, setRows] = useState<SectorPerf[]>(initial)

  useEffect(() => {
    const load = async () => {
      const res = await fetch(`/portal-api/admin/market-data/sectors/performance?weeks=${weeks}`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json().catch(() => null)
      if (d?.sectors) setRows(d.sectors)
    }
    const id = setInterval(load, 5 * 60_000)
    return () => clearInterval(id)
  }, [weeks])

  if (rows.length === 0) {
    return <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">No sector data yet (ETF history still backfilling).</div>
  }

  const cols = Math.min(weeks, Math.max(...rows.map((r) => r.weekReturns.length), 0))

  return (
    <div className="overflow-x-auto rounded border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Sector</th>
            <th className="px-3 py-2 text-right">13w</th>
            <th className="px-3 py-2 text-right">4w</th>
            <th className="px-3 py-2 text-right">1w</th>
            {Array.from({ length: cols }, (_, i) => (
              <th key={i} className="px-2 py-2 text-center font-normal text-gray-600">w-{cols - i}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map((s) => {
            const tail = s.weekReturns.slice(-cols)
            return (
              <tr key={s.ticker} className="text-gray-200">
                <td className="px-3 py-2">
                  <span className="font-medium">{s.sector}</span>
                  <span className="ml-2 text-xs text-gray-500">{s.ticker.replace(/_US_EQ$/i, '')}</span>
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums" style={cell(s.trailing13w, 0.15)}>{pct(s.trailing13w)}</td>
                <td className="px-3 py-2 text-right tabular-nums" style={cell(s.trailing4w, 0.08)}>{pct(s.trailing4w)}</td>
                <td className="px-3 py-2 text-right tabular-nums" style={cell(s.latest)}>{pct(s.latest)}</td>
                {Array.from({ length: cols }, (_, i) => {
                  const r = tail[i] ?? null
                  return <td key={i} className="px-2 py-2 text-center text-xs tabular-nums" style={cell(r)} title={pct(r)}>{r == null ? '' : (r * 100).toFixed(0)}</td>
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
