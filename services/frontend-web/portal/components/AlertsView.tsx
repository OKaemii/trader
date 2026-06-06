'use client'

import { useState } from 'react'
import { type Money } from '@/types/trader'

export interface AlertRule {
  id: string
  ticker: string
  kind: 'entry' | 'stop' | 'target'
  direction: 'above' | 'below'
  level: Money
  enabled: boolean
  cooldownH: number
  lastFiredAt?: number
  source: 'manual' | 'tradeplan'
  updatedAt: number
}

const empty = { ticker: '', kind: 'entry' as const, direction: 'above' as const, level: '', currency: 'USD' as const, cooldownH: '24' }

export function AlertsView({ initial }: { initial: AlertRule[] }) {
  const [rules, setRules] = useState<AlertRule[]>(initial)
  const [form, setForm] = useState<typeof empty>(empty)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const r = await fetch('/portal-api/admin/signals/alerts', { cache: 'no-store' })
    if (r.ok) { const d = await r.json().catch(() => null); if (d?.rules) setRules(d.rules) }
  }

  const create = async () => {
    const amount = Number(form.level)
    if (!form.ticker.trim() || !Number.isFinite(amount)) { window.alert('Ticker and a numeric level are required.'); return }
    setBusy(true)
    try {
      await fetch('/portal-api/admin/signals/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: form.ticker.trim(),
          kind: form.kind,
          direction: form.direction,
          level: { amount, currency: form.currency },
          cooldownH: Number(form.cooldownH) || 24,
          enabled: true,
        }),
      })
      setForm(empty)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (rule: AlertRule) => {
    if (!window.confirm(`Delete the ${rule.kind} alert for ${rule.ticker}?`)) return
    await fetch(`/portal-api/admin/signals/alerts/${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
    await refresh()
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-medium text-gray-300">New alert</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <input className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" placeholder="Ticker (AAPL_US_EQ)" value={form.ticker} onChange={(e) => setForm((f) => ({ ...f, ticker: e.target.value }))} />
          <select className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as typeof f.kind }))}>
            <option value="entry">entry</option><option value="stop">stop</option><option value="target">target</option>
          </select>
          <select className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" value={form.direction} onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value as typeof f.direction }))}>
            <option value="above">above</option><option value="below">below</option>
          </select>
          <input className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" placeholder="Level" value={form.level} onChange={(e) => setForm((f) => ({ ...f, level: e.target.value }))} />
          <select className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm" value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value as typeof f.currency }))}>
            <option value="USD">USD</option><option value="GBP">GBP</option>
          </select>
          <button onClick={() => void create()} disabled={busy} className="rounded bg-emerald-700 px-3 py-1 text-sm hover:bg-emerald-600 disabled:opacity-50">Add</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded border border-gray-800 bg-gray-900">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Ticker</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Condition</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Last fired</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {rules.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No alert rules yet.</td></tr>
            ) : rules.map((r) => (
              <tr key={r.id} className={r.enabled ? 'text-gray-200' : 'text-gray-500'}>
                <td className="px-3 py-2 font-medium">{r.ticker.replace(/_US_EQ$/i, '').replace(/l_EQ$/i, '.L')}</td>
                <td className="px-3 py-2">{r.kind}</td>
                <td className="px-3 py-2 tabular-nums">{r.direction} {r.level.amount} {r.level.currency}</td>
                <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${r.source === 'tradeplan' ? 'bg-indigo-900 text-indigo-200' : 'bg-gray-800 text-gray-400'}`}>{r.source}</span></td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.lastFiredAt ? new Date(r.lastFiredAt).toLocaleString() : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => void remove(r)} className="rounded bg-gray-800 px-2 py-0.5 text-xs text-red-300 hover:bg-gray-700">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
