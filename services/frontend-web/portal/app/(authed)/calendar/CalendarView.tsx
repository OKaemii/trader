'use client'

import { useEffect, useState } from 'react'

export interface EarningsEvent {
  ticker: string
  nextEarningsDate: number | null
  dividendDate: number | null
  source: string
}

function fmt(ts: number | null): string {
  return ts == null ? '—' : new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
function daysUntil(ts: number | null): number | null {
  return ts == null ? null : Math.ceil((ts - Date.now()) / 86_400_000)
}

export function CalendarView({ initial }: { initial: EarningsEvent[] }) {
  const [events] = useState<EarningsEvent[]>(initial)
  const [held, setHeld] = useState<Set<string>>(new Set())

  useEffect(() => {
    const load = async () => {
      const r = await fetch('/portal-api/admin/trading/positions', { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json().catch(() => null)
      setHeld(new Set<string>((d?.positions ?? []).map((p: { ticker: string }) => p.ticker)))
    }
    void load()
  }, [])

  if (events.length === 0) {
    return <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">No upcoming earnings in the window (coverage still building).</div>
  }

  const sorted = [...events].sort((a, b) => (a.nextEarningsDate ?? Infinity) - (b.nextEarningsDate ?? Infinity))
  return (
    <div className="overflow-x-auto rounded border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Ticker</th>
            <th className="px-3 py-2">Next earnings</th>
            <th className="px-3 py-2 text-right">In</th>
            <th className="px-3 py-2">Dividend</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {sorted.map((e) => {
            const isHeld = held.has(e.ticker)
            const d = daysUntil(e.nextEarningsDate)
            const soon = d != null && d <= 10 && d >= 0
            return (
              <tr key={e.ticker} className={isHeld ? 'bg-gray-800/40 text-gray-100' : 'text-gray-300'}>
                <td className="px-3 py-2">
                  <span className={isHeld ? 'font-semibold' : ''}>{e.ticker.replace(/_US_EQ$/i, '').replace(/l_EQ$/i, '.L')}</span>
                  {isHeld && <span className="ml-2 rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300">held</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{fmt(e.nextEarningsDate)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${soon && isHeld ? 'font-semibold text-red-400' : soon ? 'text-amber-300' : 'text-gray-500'}`}>
                  {d != null ? `${d}d` : '—'}
                </td>
                <td className="px-3 py-2 tabular-nums text-gray-500">{fmt(e.dividendDate)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
