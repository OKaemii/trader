import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { UniverseTab } from './UniverseTab'
import { ScreenerTab } from './ScreenerTab'
import { SectorsTab } from './SectorsTab'
import { CalendarTab } from './CalendarTab'

// Discover workspace (Task 7): where to hunt — the universe + why each name is in it, the nightly
// technical screener, sector rotation, and the earnings/dividend calendar. One tab = one server
// component = one authedFetch (only the active tab's fetch runs). The four old routes
// (/universe, /screener, /sectors, /calendar) now redirect here with the matching ?tab=.
const TABS = [
  { key: 'universe', label: 'Universe' },
  { key: 'screener', label: 'Screener' },
  { key: 'sectors', label: 'Sectors' },
  { key: 'calendar', label: 'Calendar' },
] as const

export default async function DiscoverPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams           // searchParams is a Promise in Next 16 — MUST await
  const active = resolveTab(TABS, tab)          // unknown/absent -> first tab (universe)
  return (
    <WorkspaceShell title="Discover" tabs={TABS} active={active}>
      {active === 'universe' && <UniverseTab />}
      {active === 'screener' && <ScreenerTab />}
      {active === 'sectors' && <SectorsTab />}
      {active === 'calendar' && <CalendarTab />}
    </WorkspaceShell>
  )
}
