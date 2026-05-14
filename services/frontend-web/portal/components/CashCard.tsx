'use client'
import { useEffect, useState } from 'react'

interface CashState {
  free?: number
  total?: number
  mode?: 'paper' | 'demo' | 'live'
  error?: string
}

export function CashCard() {
  const [cash, setCash] = useState<CashState | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/portal-api/admin/trading/cash')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) { setCash(d); setLoading(false) } })
        .catch(() => { if (!cancelled) setLoading(false) })
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const fmt = (n: number | undefined) =>
    n === undefined ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'GBP' })

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Account</h2>
        {cash?.mode && (
          <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            cash.mode === 'live' ? 'bg-red-600 text-white' :
            cash.mode === 'demo' ? 'bg-amber-600 text-white' :
            'bg-gray-700 text-gray-200'
          }`}>{cash.mode}</span>
        )}
      </div>
      {loading ? (
        <div className="mt-3 h-12 animate-pulse rounded bg-gray-800" />
      ) : cash?.error ? (
        <p className="mt-3 text-sm text-red-400">{cash.error}</p>
      ) : cash?.mode === 'paper' ? (
        <p className="mt-3 text-xs text-gray-500">No broker connection in paper mode.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Total NAV</div>
            <div className="font-mono text-lg text-white">{fmt(cash?.total)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Free cash</div>
            <div className="font-mono text-lg text-emerald-400">{fmt(cash?.free)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
