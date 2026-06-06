import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { ChartsTab } from './ChartsTab'
import { MarketDataTab } from './MarketDataTab'
import { BacktestsTab } from './BacktestsTab'
import { SignalsTab } from './SignalsTab'

// Research workspace (IA-redesign Task 8): collapses the former Charts, Market Data,
// Market Calendar, Research (backtests), and Signals (list) pages into one
// deep-linkable `?tab=` workspace. Only the active tab's async server component is
// rendered/awaited, so exactly one tab's authedFetch runs per request. The old
// /charts, /market-data, /market-data/calendar, and /signals (list) routes are now
// redirect stubs into this workspace; this route replaces the old /research page,
// whose backtests body lives on as the Backtests tab.
const TABS = [
  { key: 'charts',      label: 'Charts' },
  { key: 'market-data', label: 'Market Data' },
  { key: 'backtests',   label: 'Backtests' },
  { key: 'signals',     label: 'Signals' },
] as const

export default async function ResearchPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams           // searchParams is a Promise in Next 16 — MUST await
  const active = resolveTab(TABS, tab)          // unknown/absent -> first tab (charts)
  return (
    <WorkspaceShell title="Research" tabs={TABS} active={active}>
      {active === 'charts'      && <ChartsTab />}
      {active === 'market-data' && <MarketDataTab />}
      {active === 'backtests'   && <BacktestsTab />}
      {active === 'signals'     && <SignalsTab />}
    </WorkspaceShell>
  )
}
