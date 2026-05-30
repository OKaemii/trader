import { ReconciliationView } from '@/components/ReconciliationView'
import { authedFetch } from '@/app/lib/auth-fetch'

// SSR-seed open findings + recent NAV so the page renders populated on first paint, then the
// client view polls every 15s (CashCard / CircuitBreakerCard pattern).
async function seed() {
  try {
    const [f, n] = await Promise.all([
      authedFetch('/admin/api/trading/reconcile/findings?open=true&limit=100'),
      authedFetch('/admin/api/trading/reconcile/nav?limit=50'),
    ])
    const findings = f.ok ? ((await f.json()).findings ?? []) : []
    const nav = n.ok ? ((await n.json()).nav ?? []) : []
    return { findings, nav }
  } catch {
    return { findings: [], nav: [] }
  }
}

export default async function ReconciliationPage() {
  const { findings, nav } = await seed()
  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Reconciliation</h1>
        <p className="mt-1 text-sm text-gray-400">
          Three-way reconciliation between system state (Mongo), broker truth (T212), and the
          append-only audit ledger (Timescale). Position/order drift below threshold can auto-heal
          to broker truth when enabled; cash drift and out-of-band trades always page for review.
          Only available in demo/live mode.
        </p>
      </div>
      <ReconciliationView initialFindings={findings} initialNav={nav} />
    </div>
  )
}
