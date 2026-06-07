'use client'

import { useEffect, useState } from 'react'
import { type Money, formatMoney } from '@/types/trader'
import { Explain } from '@/components/Explain'
import { TickerChip } from '@/components/TickerChip'

// Mirror of signal-service's EnrichedPosition (Trading.EnrichedPosition). Kept local per the
// portal convention — don't import service-side types into client components.
export interface EnrichedPosition {
  ticker: string
  quantity: number
  currency: 'GBP' | 'USD' | null
  currentPrice: Money | null
  entryPrice: number | null
  entryAt: number | null
  daysHeld: number | null
  stop: Money | null
  target: Money | null
  rMultiple: number | null
  stopDistancePct: number | null
  note: string | null
}

function pct(n: number | null): string {
  return n == null ? '—' : `${(n * 100).toFixed(1)}%`
}

function rColor(r: number | null): string {
  if (r == null) return 'text-gray-500'
  if (r > 0) return 'text-emerald-400'
  if (r < 0) return 'text-red-400'
  return 'text-gray-300'
}

export function PositionsPanel({ initial }: { initial: EnrichedPosition[] }) {
  const [rows, setRows] = useState<EnrichedPosition[]>(initial)
  const [edit, setEdit] = useState<Record<string, { stop: string; target: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async () => {
    const res = await fetch('/portal-api/admin/signals/positions/enriched', { cache: 'no-store' })
    if (!res.ok) return
    const d = await res.json().catch(() => null)
    if (d?.positions) setRows(d.positions)
  }

  useEffect(() => {
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [])

  const save = async (p: EnrichedPosition) => {
    const e = edit[p.ticker]
    const currency = p.currency ?? p.currentPrice?.currency ?? 'USD'
    const toMoney = (s: string | undefined): Money | null => {
      if (s == null || s.trim() === '') return null
      const amount = Number(s)
      return Number.isFinite(amount) ? { amount, currency } : null
    }
    const stop = toMoney(e?.stop)
    const target = toMoney(e?.target)
    if (!window.confirm(`Save trade plan for ${p.ticker}?\nStop: ${stop ? stop.amount : '(none)'}  Target: ${target ? target.amount : '(none)'}`)) return
    setBusy(p.ticker)
    try {
      await fetch(`/portal-api/admin/signals/trade-plans/${encodeURIComponent(p.ticker)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stop, target, updatedBy: 'portal' }),
      })
      setEdit((m) => { const n = { ...m }; delete n[p.ticker]; return n })
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) {
    return <div className="rounded border border-gray-800 bg-gray-900 px-4 py-3 text-sm text-gray-400">No open positions.</div>
  }

  return (
    <div className="overflow-x-auto rounded border border-gray-800 bg-gray-900">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2">Ticker</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-right">Entry</th>
            <th className="px-3 py-2 text-right">Current</th>
            <th className="px-3 py-2 text-right">Stop (dist)</th>
            <th className="px-3 py-2 text-right">Target</th>
            <th className="px-3 py-2 text-right">Days</th>
            <th className="px-3 py-2 text-right">
              <span className="inline-flex items-center justify-end gap-1">
                R
                <Explain id="rMultiple" />
              </span>
            </th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-800">
          {rows.map((p) => {
            const e = edit[p.ticker]
            const editing = e != null
            return (
              <tr key={p.ticker} className="text-gray-200">
                <td className="px-3 py-2 font-medium"><TickerChip symbol={p.ticker} /></td>
                <td className="px-3 py-2 text-right tabular-nums">{p.quantity}</td>
                <td className="px-3 py-2 text-right tabular-nums">{p.entryPrice != null ? p.entryPrice.toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.currentPrice)}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {editing ? (
                    <input
                      className="w-20 rounded border border-gray-700 bg-gray-800 px-1 py-0.5 text-right"
                      value={e.stop}
                      onChange={(ev) => setEdit((m) => ({ ...m, [p.ticker]: { ...e, stop: ev.target.value } }))}
                      placeholder="stop"
                    />
                  ) : (
                    <span>
                      {formatMoney(p.stop)}{' '}
                      <span className={p.stopDistancePct != null && p.stopDistancePct < 0 ? 'text-red-400' : 'text-gray-500'}>
                        ({pct(p.stopDistancePct)})
                      </span>
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {editing ? (
                    <input
                      className="w-20 rounded border border-gray-700 bg-gray-800 px-1 py-0.5 text-right"
                      value={e.target}
                      onChange={(ev) => setEdit((m) => ({ ...m, [p.ticker]: { ...e, target: ev.target.value } }))}
                      placeholder="target"
                    />
                  ) : (
                    formatMoney(p.target)
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.daysHeld != null ? Math.floor(p.daysHeld) : '—'}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${rColor(p.rMultiple)}`}>
                  {p.rMultiple != null ? `${p.rMultiple.toFixed(2)}R` : '—'}
                </td>
                <td className="px-3 py-2 text-right">
                  {editing ? (
                    <div className="flex justify-end gap-1">
                      <button
                        disabled={busy === p.ticker}
                        onClick={() => void save(p)}
                        className="rounded bg-emerald-700 px-2 py-0.5 text-xs hover:bg-emerald-600 disabled:opacity-50"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEdit((m) => { const n = { ...m }; delete n[p.ticker]; return n })}
                        className="rounded bg-gray-700 px-2 py-0.5 text-xs hover:bg-gray-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEdit((m) => ({ ...m, [p.ticker]: { stop: p.stop ? String(p.stop.amount) : '', target: p.target ? String(p.target.amount) : '' } }))}
                      className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-700"
                    >
                      Plan
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
