'use client'

import { useEffect, useState } from 'react'

// Transaction-cost analysis: per-day cost summary + recent per-fill slippage. SSR-seeded,
// 30s poll. Costs are in bps; positive = worse than the reference mid (a real cost).
type DailyRow = { day: string; fills: number; avg_cost_bps: number | null; avg_fill_slip_bps: number | null; cost_coverage: number }
type RecentRow = {
  computed_at: string; ticker: string; side: string; signal_id: string | null
  fill_price: number; total_cost_bps: number | null; fill_slip_bps: number | null
  quote_fill_source: string | null
}

const bps = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}`)

export function TcaView({ initialDaily, initialRecent }: { initialDaily: DailyRow[]; initialRecent: RecentRow[] }) {
  const [daily, setDaily] = useState<DailyRow[]>(initialDaily)
  const [recent, setRecent] = useState<RecentRow[]>(initialRecent)

  useEffect(() => {
    const refresh = () =>
      fetch('/portal-api/admin/trading/tca?limit=100')
        .then((r) => r.json())
        .then((d: { daily?: DailyRow[]; recent?: RecentRow[] }) => {
          setDaily(Array.isArray(d.daily) ? d.daily : [])
          setRecent(Array.isArray(d.recent) ? d.recent : [])
        })
        .catch(() => {})
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="space-y-6">
      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-300">Daily cost summary (bps)</h2>
        {daily.length === 0 ? (
          <p className="text-xs text-gray-400">No TCA rows yet — populated as fills land against the quote feed.</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-gray-500"><tr><th className="py-1">Day</th><th>Fills</th><th>Avg total cost</th><th>Avg fill slip</th><th>Cost coverage</th></tr></thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.day} className="border-t border-gray-800">
                  <td className="py-1 text-gray-400">{d.day.slice(0, 10)}</td>
                  <td className="text-gray-300">{d.fills}</td>
                  <td className={Number(d.avg_cost_bps) > 30 ? 'text-red-400' : 'text-gray-200'}>{bps(d.avg_cost_bps)}</td>
                  <td className="text-gray-200">{bps(d.avg_fill_slip_bps)}</td>
                  <td className="text-gray-500">{d.cost_coverage}/{d.fills}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-300">Recent fills</h2>
        {recent.length === 0 ? (
          <p className="text-xs text-gray-400">No fills recorded.</p>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="text-gray-500"><tr><th className="py-1">When</th><th>Ticker</th><th>Side</th><th>Fill</th><th>Total bps</th><th>Fill slip bps</th><th>Quote src</th></tr></thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.computed_at}-${i}`} className="border-t border-gray-800">
                  <td className="py-1 text-gray-500">{new Date(r.computed_at).toISOString().slice(5, 19).replace('T', ' ')}</td>
                  <td className="font-mono text-emerald-400">{r.ticker}</td>
                  <td className="text-gray-300">{r.side}</td>
                  <td className="text-gray-200">{Number(r.fill_price).toFixed(2)}</td>
                  <td className={Number(r.total_cost_bps) > 30 ? 'text-red-400' : 'text-gray-200'}>{bps(r.total_cost_bps)}</td>
                  <td className="text-gray-200">{bps(r.fill_slip_bps)}</td>
                  <td className="text-gray-500">{r.quote_fill_source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
