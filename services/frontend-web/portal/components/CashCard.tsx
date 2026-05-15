'use client'
import { useEffect, useState } from 'react'
import { type Money, formatMoney } from '@/types/trader'

interface CashState {
  // Wire format post-FX-fix: {amount, currency} Money pairs. Pre-fix payloads where
  // free/total were bare numbers won't render — that's fine, they're long gone after
  // the deploy.
  free?: Money
  total?: Money
  mode?: 'Paper' | 'Demo' | 'Live'
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

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Account</h2>
        {cash?.mode && (
          <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            cash.mode === 'Live' ? 'bg-red-600 text-white' :
            cash.mode === 'Demo' ? 'bg-amber-600 text-white' :
            'bg-gray-700 text-gray-200'
          }`}>{cash.mode}</span>
        )}
      </div>
      {loading ? (
        <div className="mt-3 h-12 animate-pulse rounded bg-gray-800" />
      ) : cash?.error ? (
        <p className="mt-3 text-sm text-red-400">{cash.error}</p>
      ) : cash?.mode === 'Paper' ? (
        <p className="mt-3 text-xs text-gray-500">No broker connection in paper mode.</p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Total NAV</div>
            <div className="font-mono text-lg text-white">{formatMoney(cash?.total)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Free cash</div>
            <div className="font-mono text-lg text-emerald-400">{formatMoney(cash?.free)}</div>
          </div>
        </div>
      )}
    </div>
  )
}
