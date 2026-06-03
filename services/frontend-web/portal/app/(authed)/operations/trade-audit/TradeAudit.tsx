'use client'

import { useState } from 'react'

// Mirrors trading-service /admin/api/trading/fills (FillRow).
interface Fill {
  filledAt: number; ticker: string; side: string; quantity: number
  fillPrice: number; currency: string; orderId: string; signalId: string | null; source: string
}
export interface FillsPayload { fills: Fill[]; days: number }

const ccy = (v: number, c: string) =>
  `${c === 'GBP' ? '£' : c === 'USD' ? '$' : ''}${v.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
const dt = (t: number) => new Date(t).toLocaleString('en-GB')

export function TradeAudit({ initial }: { initial: FillsPayload }) {
  const [data, setData] = useState<FillsPayload>(initial)
  const [ticker, setTicker] = useState('')
  const [side, setSide] = useState('')
  const [days, setDays] = useState(String(initial.days))
  const [busy, setBusy] = useState(false)

  async function apply(): Promise<void> {
    setBusy(true)
    try {
      const p = new URLSearchParams()
      if (ticker.trim()) p.set('ticker', ticker.trim())
      if (side) p.set('side', side)
      p.set('days', days)
      const r = await fetch(`/portal-api/admin/trading/fills?${p.toString()}`).then((x) => x.json()).catch(() => null)
      if (r && Array.isArray(r.fills)) setData(r)
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-400">Ticker
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void apply() }}
            placeholder="all"
            className="mt-1 block w-44 rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100 focus:border-emerald-600 focus:outline-none"
          />
        </label>
        <label className="text-xs text-gray-400">Side
          <select value={side} onChange={(e) => setSide(e.target.value)}
            className="mt-1 block rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100">
            <option value="">All</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>
        <label className="text-xs text-gray-400">Window
          <select value={days} onChange={(e) => setDays(e.target.value)}
            className="mt-1 block rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm text-gray-100">
            <option value="7">7d</option>
            <option value="30">30d</option>
            <option value="90">90d</option>
            <option value="365">1y</option>
          </select>
        </label>
        <button onClick={() => void apply()} disabled={busy}
          className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-600 disabled:opacity-50">
          {busy ? 'Loading…' : 'Apply'}
        </button>
        <span className="text-xs text-gray-500">{data.fills.length} fill(s)</span>
      </div>

      <div className="overflow-x-auto rounded border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2">Side</th>
              <th className="px-3 py-2">Qty</th>
              <th className="px-3 py-2">Price</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Order</th>
              <th className="px-3 py-2">Signal</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-950">
            {data.fills.length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">No fills in this window.</td></tr>
            ) : (
              data.fills.map((f, i) => (
                <tr key={`${f.orderId}-${i}`}>
                  <td className="px-3 py-2 text-gray-300">{dt(f.filledAt)}</td>
                  <td className="px-3 py-2 font-medium text-gray-100">{f.ticker}</td>
                  <td className={`px-3 py-2 font-semibold ${f.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{f.side}</td>
                  <td className="px-3 py-2 text-gray-300">{f.quantity}</td>
                  <td className="px-3 py-2 text-gray-300">{ccy(f.fillPrice, f.currency)}</td>
                  <td className="px-3 py-2 text-gray-300">{ccy(f.fillPrice * f.quantity, f.currency)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{f.orderId.slice(0, 10)}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{f.signalId ? f.signalId.slice(0, 8) : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
