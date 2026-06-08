import { WorkspaceShell } from '@/components/WorkspaceShell'
import { resolveTab } from '@/app/lib/tabs'
import { TradeAuditTab } from './TradeAuditTab'
import { ReconciliationTab } from './ReconciliationTab'
import { TcaTab } from './TcaTab'
import { MarketDataTab } from './MarketDataTab'
import { FundamentalsTab } from './FundamentalsTab'

// Operations workspace (Task 11): the forensic post-trade surfaces — what actually executed
// (Trade Audit), whether system/broker/ledger agree (Reconciliation), and how much execution cost
// (TCA). One tab = one server component = one authedFetch (only the active tab's fetch runs). The
// three old routes (/operations/{trade-audit,reconciliation,tca}) now redirect here with the
// matching ?tab=. /operations/console is a separate workspace (Build) and stays its own route. The
// Market Data tab (relocated here from Research) is the OPERATIONAL poll-config / session-calendar /
// holiday-feed admin — a run-the-platform concern; /market-data + /market-data/calendar redirect here.
// The PIT Fundamentals tab (card 134) is the operator surface over the fundamentals-ingestion
// write-side — monitor coverage/lag/quarantine/feed-health, force a backfill, edit the EDGAR UA.
const TABS = [
  { key: 'trade-audit', label: 'Trade Audit' },
  { key: 'reconciliation', label: 'Reconciliation' },
  { key: 'tca', label: 'TCA' },
  { key: 'market-data', label: 'Market Data' },
  { key: 'fundamentals', label: 'PIT Fundamentals' },
] as const

export default async function OperationsPage(
  { searchParams }: { searchParams: Promise<{ tab?: string }> },
) {
  const { tab } = await searchParams           // searchParams is a Promise in Next 16 — MUST await
  const active = resolveTab(TABS, tab)          // unknown/absent -> first tab (trade-audit)
  return (
    <WorkspaceShell title="Operations" tabs={TABS} active={active}>
      {active === 'trade-audit' && <TradeAuditTab />}
      {active === 'reconciliation' && <ReconciliationTab />}
      {active === 'tca' && <TcaTab />}
      {active === 'market-data' && <MarketDataTab />}
      {active === 'fundamentals' && <FundamentalsTab />}
    </WorkspaceShell>
  )
}
