// Reads market-data /health and surfaces the cumulative Yahoo-call savings from the
// session gate. (gate_skips_total / (gate_skips_total + total_cycles)) is the
// fraction of intended cycles that were skipped. Rendered as a small dashboard tile.

import { authedFetch } from '@/app/lib/auth-fetch'
import Link from 'next/link'

interface MarketDataHealth {
  total_cycles?: number
  gate_skips_total?: number
  last_gate_skip_ts?: number | null
}

async function fetchHealth(): Promise<MarketDataHealth | null> {
  try {
    const r = await authedFetch('/admin/api/market-data/health')
    if (!r.ok) return null
    return (await r.json()) as MarketDataHealth
  } catch {
    return null
  }
}

export async function SessionSavingsTile() {
  const h = await fetchHealth()
  if (!h) return null

  const skips  = h.gate_skips_total ?? 0
  const cycles = h.total_cycles ?? 0
  const totalIntended = skips + cycles
  const pct = totalIntended > 0 ? (skips / totalIntended) * 100 : 0
  const lastSkip = h.last_gate_skip_ts
    ? new Date(h.last_gate_skip_ts).toUTCString().slice(5, 22) + ' UTC'
    : 'never'

  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-300">Yahoo calls saved by gate</h2>
        <Link
          href="/market-data/calendar"
          className="text-[11px] text-gray-400 underline-offset-2 hover:text-emerald-300 hover:underline"
        >
          calendar →
        </Link>
      </div>
      <div className="mt-2 text-2xl font-semibold text-white">
        {skips.toLocaleString()}
        <span className="ml-2 text-sm font-normal text-gray-400">
          ({pct.toFixed(1)}% of intended cycles)
        </span>
      </div>
      <div className="mt-1 text-xs text-gray-500">
        {cycles.toLocaleString()} cycles polled · last skip {lastSkip}
      </div>
    </div>
  )
}
