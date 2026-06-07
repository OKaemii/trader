import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { StrategyTab } from './StrategyTab'
import { ConsoleTab } from './ConsoleTab'
import { AlertsTab } from './AlertsTab'
import { BacktestsTab } from './BacktestsTab'

// Build workspace (IA-redesign Task 9) — collapses the old /strategy-config, /operations/console,
// and /alerts pages into one deep-linkable `?tab=` workspace. Only the active tab's async server
// component is rendered/awaited, so exactly one tab's authedFetch runs per request. The old routes
// are now redirect stubs into this workspace. The Console tab carries the SAFETY-CRITICAL panic
// controls (kill switch / pause / flatten) — always visible, never mode-gated. The Backtests tab
// (relocated here from Research) runs the walk-forward / MCPT validators — a build-the-strategy
// concern; /research?tab=backtests redirects here.
const TABS = [
  { key: 'strategy', label: 'Strategy' },
  { key: 'console', label: 'Console' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'backtests', label: 'Backtests' },
] as const

export default async function BuildPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams // searchParams is a Promise in Next 16 — MUST await
  const active = resolveTab(TABS, tab) // unknown/absent -> first tab (strategy)
  return (
    <WorkspaceShell title="Build" tabs={TABS} active={active}>
      {active === 'strategy' && <StrategyTab />}
      {active === 'console' && <ConsoleTab />}
      {active === 'alerts' && <AlertsTab />}
      {active === 'backtests' && <BacktestsTab />}
    </WorkspaceShell>
  )
}
