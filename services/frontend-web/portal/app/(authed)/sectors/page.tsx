import { authedFetch } from '@/app/lib/auth-fetch'
import { SectorHeatmap, type SectorPerf } from './SectorHeatmap'

// Sector Rotation — weekly performance of the 11 SPDR sector ETFs (+ SPY). Long-only edge is
// knowing which sectors have momentum, so this is the "where to hunt" view.
export default async function SectorsPage() {
  const r = await authedFetch('/admin/api/market-data/sectors/performance?weeks=13')
  const data = r.ok ? await r.json().catch(() => null) : null
  const sectors: SectorPerf[] = data?.sectors ?? []

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Sector Rotation</h1>
        <p className="text-sm text-gray-400">
          Weekly performance of the sector SPDR ETFs, sorted by trailing-quarter momentum. Greener =
          stronger; that&apos;s where the long-only hunt should focus.
        </p>
      </div>
      {data ? (
        <SectorHeatmap initial={sectors} weeks={data.weeks ?? 13} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Sector data unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
