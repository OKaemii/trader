import { authedFetch } from '@/app/lib/auth-fetch'
import { ScreenerView, type ScreenSnapshot } from '@/components/ScreenerView'

// Screener tab of the Discover workspace — the old /screener page body verbatim.
// The nightly technical scan (52w highs, 50-MA breakouts, unusual volume, pullback-in-uptrend).
// Swing trading is done after the close, so this surfaces ~10 candidates once a day.
export async function ScreenerTab() {
  const r = await authedFetch('/admin/api/market-data/screener/latest')
  const snap: ScreenSnapshot | null = r.ok ? await r.json().catch(() => null) : null

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Nightly swing candidates — near 52-week highs, fresh 50-day-MA breakouts, unusual volume,
        and pullbacks to support in an uptrend. Run on demand and tune the thresholds below.
      </p>
      {r.ok ? (
        <ScreenerView initial={snap} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Screener unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
