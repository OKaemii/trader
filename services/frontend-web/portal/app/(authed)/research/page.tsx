import { redirect } from 'next/navigation'
import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { ChartsTab } from './ChartsTab'
import { SignalsTab } from './SignalsTab'

// Research workspace. The relocation pass (Task 22) moved the operational Market Data
// admin out to Operations and the Backtests validators out to Build — both are
// run-the-platform / build-the-strategy concerns, not per-symbol research. What stays
// here is the per-symbol research surface; Task 23 rebuilds this into the entity-centric
// `?symbol=` workspace (Overview · Signals · Strategy Impact · Fundamentals · History).
//
// Until then, `history` is a PLACEHOLDER tab rendering the existing price/candlestick view
// (ChartsTab) so the /charts redirect stub resolves; Task 23 fleshes it into the full
// History tab. `signals` keeps the signal feed (the /signals list stub targets it). Only
// the active tab's async server component is rendered/awaited (one authedFetch per request).
const TABS = [
  { key: 'history', label: 'History' },
  { key: 'signals', label: 'Signals' },
] as const

// Old deep-links to the relocated tabs (bookmarks / saved URLs) get a server-side redirect to
// their new home so `/research?tab=backtests` and `/research?tab=market-data` never silently
// resolve to the first Research tab. Keyed off the raw `?tab=` value (these keys are no longer
// in TABS, so they'd otherwise fall through to `history`).
const RELOCATED_TABS: Record<string, string> = {
  backtests:     '/build?tab=backtests',
  'market-data': '/operations?tab=market-data',
}

export default async function ResearchPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams           // searchParams is a Promise in Next 16 — MUST await
  if (tab && RELOCATED_TABS[tab]) redirect(RELOCATED_TABS[tab])
  const active = resolveTab(TABS, tab)          // unknown/absent -> first tab (history)
  return (
    <WorkspaceShell title="Research" tabs={TABS} active={active}>
      {active === 'history' && <ChartsTab />}
      {active === 'signals' && <SignalsTab />}
    </WorkspaceShell>
  )
}
