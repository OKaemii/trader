import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { PositionsTab } from './PositionsTab'
import { PerformanceTab } from './PerformanceTab'
import { RiskLimitsTab } from './RiskLimitsTab'
import { TripsTab } from './TripsTab'

// Portfolio workspace (IA-redesign Task 10) — collapses the old /positions,
// /operations/performance, /operations/risk-limits, and /risk/trips (list) pages into one
// deep-linkable workspace. The per-trip detail stays a real route at /risk/trips/[id].
// Each XTab is the old page's body verbatim as an async server component; only the active
// tab is rendered, so only its authedFetch runs.
const TABS = [
  { key: 'positions', label: 'Positions' },
  { key: 'performance', label: 'Performance' },
  { key: 'risk-limits', label: 'Risk Limits' },
  { key: 'trips', label: 'Circuit Trips' },
] as const

export default async function PortfolioPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams
  const active = resolveTab(TABS, tab)
  return (
    <WorkspaceShell title="Portfolio" tabs={TABS} active={active}>
      {active === 'positions' && <PositionsTab />}
      {active === 'performance' && <PerformanceTab />}
      {active === 'risk-limits' && <RiskLimitsTab />}
      {active === 'trips' && <TripsTab />}
    </WorkspaceShell>
  )
}
