import { getUniverseOverrides } from '@/app/actions/admin'
import { authedFetch } from '@/app/lib/auth-fetch'
import { UniverseEditor } from '@/components/UniverseEditor'
import { ScannerPanel } from '@/components/ScannerPanel'
import { UniverseOverview } from '@/components/UniverseOverview'
import { BarHistoryExplorer } from '@/components/BarHistoryExplorer'

// Universe tab of the Discover workspace — the old /universe page body verbatim.
// Universe = the single EODHD-fed scan. The market scanner (cap → QMJ funnel, per-name table, the
// strategy's selected basket) lives here so there is one place to see what the universe is and why
// each name is in it. SSR-seed everything. Only the page title/chrome is hoisted to WorkspaceShell.
export async function UniverseTab() {
  const [result, snapRes, healthRes, pieRes] = await Promise.all([
    getUniverseOverrides(),
    authedFetch('/admin/api/market-data/scanner/snapshot'),
    authedFetch('/admin/api/market-data/scanner/feed-health'),
    authedFetch('/admin/api/signals/pies/strategy/high_velocity_v1'),   // selected basket (best-effort)
  ])

  if (!result.ok) {
    return (
      <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
        {result.status === 401 || result.status === 403
          ? 'Admin role required.'
          : `Failed to load (${result.status}).`}
      </div>
    )
  }

  const snapshot = snapRes.ok ? await snapRes.json().catch(() => null) : null
  const health = healthRes.ok ? await healthRes.json().catch(() => null) : null
  const pie = pieRes.ok ? await pieRes.json().catch(() => null) : null

  // Fallback for the universe overview when the scanner snapshot is unavailable (market-data down /
  // legacy pod). Market is inferred from the T212 suffix, ADV defaults to 0.
  const detailed = result.data.activeUniverseDetailed ?? result.data.activeUniverse.map((ticker) => ({
    ticker,
    name: ticker,
    sector: 'Unknown',
    market: (/_US_EQ$/.test(ticker) ? 'US' : /l_EQ$/.test(ticker) ? 'LSE' : 'OTHER') as 'US' | 'LSE' | 'OTHER',
    adv: 0,
  }))

  return (
    <div className="space-y-8">
      <p className="text-sm text-gray-400">
        The single active universe is the EODHD ≥£5B US+UK market-cap scan — market-balanced to ~100 US / 100 UK
        and ranked by market cap. The QMJ quality screen and the strategy&apos;s selected basket are shown below.
        Forced adds bypass the cap; forced removes win over the scan.
      </p>

      {snapshot
        ? <ScannerPanel initialSnapshot={snapshot} initialHealth={health} initialPie={pie} />
        : <UniverseOverview instruments={detailed} updatedAt={result.data.updatedAt} />}

      <UniverseEditor initial={result.data} />
      <BarHistoryExplorer tickers={result.data.activeUniverse} />
    </div>
  )
}
