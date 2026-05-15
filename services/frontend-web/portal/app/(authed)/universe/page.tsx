import { getUniverseOverrides } from '@/app/actions/admin'
import { UniverseEditor } from './UniverseEditor'
import { UniverseOverview } from '@/components/UniverseOverview'
import { BarHistoryExplorer } from '@/components/BarHistoryExplorer'

export default async function UniversePage() {
  const result = await getUniverseOverrides()

  if (!result.ok) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Universe</h1>
        </div>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {result.status === 401 || result.status === 403
            ? 'Admin role required.'
            : `Failed to load (${result.status}).`}
        </div>
      </div>
    )
  }

  // Detailed list may be absent on legacy pods that haven't shipped the enriched endpoint
  // yet. Synthesise a minimal record so the overview still renders during the rolling
  // deploy window — market is inferred from the T212 suffix, ADV defaults to 0.
  const detailed = result.data.activeUniverseDetailed ?? result.data.activeUniverse.map((ticker) => ({
    ticker,
    name: ticker,
    sector: 'Unknown',
    market: (/_US_EQ$/.test(ticker) ? 'US' : /l_EQ$/.test(ticker) ? 'LSE' : 'OTHER') as 'US' | 'LSE' | 'OTHER',
    adv: 0,
  }))

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Universe</h1>
        <p className="mt-1 text-sm text-gray-400">
          Curated S&amp;P 100 + FTSE 100 candidate pool, ranked by 5-day average dollar volume.
          Forced adds bypass the cap; forced removes win over T212 inclusion.
        </p>
      </div>
      <UniverseOverview instruments={detailed} updatedAt={result.data.updatedAt} />
      <BarHistoryExplorer tickers={result.data.activeUniverse} />
      <UniverseEditor initial={result.data} />
    </div>
  )
}
