import { authedFetch } from '@/app/lib/auth-fetch'
import { SectorHeatmap, type SectorPerf } from '@/components/SectorHeatmap'
import { MarketNarrative, type NarrativePayload } from '@/components/MarketNarrative'

// Sectors tab of the Discover workspace — the old /sectors page body verbatim, now led by the
// market-context narrative (Task 31, plan §F). Weekly performance of the 11 SPDR sector ETFs (+ SPY).
// Long-only edge is knowing which sectors have momentum, so this is the "where to hunt" view — and the
// "Today's Market" prose at the top frames the same market state (sector returns, factor leadership,
// breadth, concentration) in words before the heatmap shows it as numbers.
export async function SectorsTab() {
  // Both seeds in parallel — the narrative is cached per-UTC-day upstream, so it's a cheap fetch.
  const [r, narrativeRes] = await Promise.all([
    authedFetch('/admin/api/market-data/sectors/performance?weeks=13'),
    authedFetch('/admin/api/market/narrative'),
  ])
  const data = r.ok ? await r.json().catch(() => null) : null
  const sectors: SectorPerf[] = data?.sectors ?? []
  const narrative: NarrativePayload | null = narrativeRes.ok
    ? await narrativeRes.json().catch(() => null)
    : null

  return (
    <div className="space-y-6">
      {/* Market-context prose — SSR-seeded; on a null seed pass `undefined` so the panel self-fetches. */}
      <MarketNarrative initial={narrative ?? undefined} />
      <p className="text-sm text-gray-400">
        Weekly performance of the sector SPDR ETFs, sorted by trailing-quarter momentum. Greener =
        stronger; that&apos;s where the long-only hunt should focus.
      </p>
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
