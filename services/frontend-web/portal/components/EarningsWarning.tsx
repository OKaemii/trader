'use client'

import { useEffect, useState } from 'react'

interface Overlap { ticker: string; daysUntil: number | null; within: boolean; nextEarningsDate: number | null }

// The biggest avoidable swing-trade disaster is holding through a surprise earnings report, so this
// flags any OPEN position reporting within 10 days. Renders nothing when nothing's flagged.
export function EarningsWarning() {
  const [flagged, setFlagged] = useState<Overlap[]>([])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const pr = await fetch('/portal-api/admin/trading/positions', { cache: 'no-store' })
      if (!pr.ok) return
      const pd = await pr.json().catch(() => null)
      const tickers: string[] = (pd?.positions ?? []).map((p: { ticker: string }) => p.ticker)
      if (tickers.length === 0) { if (!cancelled) setFlagged([]); return }
      const or = await fetch(`/portal-api/admin/market-data/earnings/overlap?tickers=${encodeURIComponent(tickers.join(','))}&days=10`, { cache: 'no-store' })
      if (!or.ok) return
      const od = await or.json().catch(() => null)
      if (!cancelled) setFlagged((od?.overlap ?? []).filter((o: Overlap) => o.within))
    }
    void load()
    const id = setInterval(load, 5 * 60_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  if (flagged.length === 0) return null
  const ordered = [...flagged].sort((a, b) => (a.daysUntil ?? 99) - (b.daysUntil ?? 99))
  return (
    <div className="rounded border border-red-800 bg-red-950 px-4 py-3 text-sm text-red-200">
      <span className="font-semibold">⚠ Earnings within 10 days:</span>{' '}
      {ordered.map((o) => `${o.ticker.replace(/_US_EQ$/i, '').replace(/l_EQ$/i, '.L')} (${o.daysUntil != null ? Math.ceil(o.daysUntil) : '?'}d)`).join(', ')}
    </div>
  )
}
