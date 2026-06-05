'use client'
import { useEffect, useState } from 'react'
import { type Money, formatMoney } from '@/types/trader'

// Trading212-style portfolio header: lead with the value, not the ops controls. SSR-seeded from
// /admin/api/trading/cash, then polled. Invested is derived (total − free) since the broker total
// already includes open positions (see the NAV double-count fix).
interface CashState {
  free?: Money
  total?: Money
  mode?: 'Paper' | 'Demo' | 'Live'
  error?: string
}

const modeChip = (mode?: string): string =>
  mode === 'Live' ? 'bg-red-600 text-white' :
  mode === 'Demo' ? 'bg-amber-600 text-white' :
  'bg-gray-700 text-gray-200'

export function PortfolioHero({ initial = null }: { initial?: CashState | null }) {
  const [cash, setCash] = useState<CashState | null>(initial)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/portal-api/admin/trading/cash')
        .then((r) => r.json())
        .then((d) => { if (!cancelled) setCash(d) })
        .catch(() => {})
    if (initial === null) load()
    const id = setInterval(load, 30_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [initial])

  const total = cash?.total
  const free = cash?.free
  const invested: Money | undefined =
    total && free && total.currency === free.currency
      ? { amount: Math.max(0, total.amount - free.amount), currency: total.currency }
      : undefined
  const investedPct =
    total && invested && total.amount > 0 ? Math.round((invested.amount / total.amount) * 100) : null

  return (
    <section className="rounded-xl border border-gray-800 bg-gradient-to-b from-gray-900 to-gray-900/60 p-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500">Portfolio value</div>
          <div className="mt-1 font-mono text-4xl font-semibold text-white">
            {cash?.mode === 'Paper' ? '—' : formatMoney(total)}
          </div>
        </div>
        {cash?.mode && (
          <span className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide ${modeChip(cash.mode)}`}>
            {cash.mode}
          </span>
        )}
      </div>

      {cash?.error ? (
        <p className="mt-3 text-sm text-red-400">{cash.error}</p>
      ) : cash?.mode === 'Paper' ? (
        <p className="mt-3 text-xs text-gray-500">Paper mode — no broker account to value. Switch to Demo/Live to see your portfolio.</p>
      ) : (
        <>
          <div className="mt-5 grid grid-cols-2 gap-4 sm:max-w-md">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Invested</div>
              <div className="mt-0.5 font-mono text-lg text-gray-100">{formatMoney(invested)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-gray-500">Available cash</div>
              <div className="mt-0.5 font-mono text-lg text-emerald-400">{formatMoney(free)}</div>
            </div>
          </div>
          {investedPct !== null && (
            <div className="mt-4 max-w-md">
              <div className="h-1.5 w-full overflow-hidden rounded bg-gray-800">
                <div className="h-full bg-emerald-500/70" style={{ width: `${investedPct}%` }} />
              </div>
              <div className="mt-1 text-[10px] text-gray-500">{investedPct}% invested · {100 - investedPct}% cash</div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
