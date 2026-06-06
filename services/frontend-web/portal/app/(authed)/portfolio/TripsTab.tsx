import Link from 'next/link'
import { authedFetch } from '@/app/lib/auth-fetch'

// Circuit Trips tab (Portfolio workspace) — the trips LIST, the body of the old /risk/trips page
// verbatim. One row per historical circuit-breaker trip. The per-trip detail stays a real route at
// /risk/trips/[id] (email/bookmark target), so the "Open →" link still points there.
interface TripRow {
  id: string
  ts: number
  reason: 'DAILY_LOSS_HALT' | 'DRAWDOWN_HALT'
  reasonText: string
  nav: number
  hwm: number
  dayOpenNav: number
  dailyLossPct: number
  drawdownPct: number
  cancelledCount: number
}

async function fetchTrips(): Promise<TripRow[] | null> {
  try {
    const r = await authedFetch('/admin/api/signals/risk/trips?limit=100')
    if (!r.ok) return null
    const body = (await r.json()) as { trips?: TripRow[] }
    return body.trips ?? []
  } catch {
    return null
  }
}

export async function TripsTab() {
  const trips = await fetchTrips()
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        One row per historical trip. Includes the risk numbers at the moment of the trip,
        the BUYs auto-cancelled, and a snapshot of the pipeline state.
      </p>
      {trips === null ? (
        <p className="text-sm text-red-400">Failed to load trips.</p>
      ) : trips.length === 0 ? (
        <p className="text-sm text-gray-500">No trips recorded. The breaker has not fired since the last system reset.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full divide-y divide-gray-800 text-sm">
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wider text-gray-400">
              <tr>
                <th className="px-4 py-2">When (UTC)</th>
                <th className="px-4 py-2">Reason</th>
                <th className="px-4 py-2 text-right">NAV</th>
                <th className="px-4 py-2 text-right">HWM</th>
                <th className="px-4 py-2 text-right">Daily loss</th>
                <th className="px-4 py-2 text-right">Drawdown</th>
                <th className="px-4 py-2 text-right">Cancelled BUYs</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 bg-gray-950">
              {trips.map((t) => (
                <tr key={t.id} className="text-gray-200">
                  <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                    {new Date(t.ts).toISOString().replace('T', ' ').slice(0, 19)}
                  </td>
                  <td className="px-4 py-2">
                    <span className={t.reason === 'DAILY_LOSS_HALT' ? 'text-amber-300' : 'text-red-300'}>
                      {t.reason}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">£{t.nav.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono">£{t.hwm.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono">{(t.dailyLossPct * 100).toFixed(2)}%</td>
                  <td className="px-4 py-2 text-right font-mono">{(t.drawdownPct * 100).toFixed(2)}%</td>
                  <td className="px-4 py-2 text-right">{t.cancelledCount}</td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/risk/trips/${t.id}`} className="text-blue-400 hover:text-blue-300">
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
