import { ResearchView } from '@/components/ResearchView'
import { FeatureAuditPanel } from '@/components/FeatureAuditPanel'
import { authedFetch } from '@/app/lib/auth-fetch'
import { QuantOnly } from '@/components/QuantOnly'

// Backtests tab (IA-redesign Task 8 — was app/(authed)/research/page.tsx, the
// route this workspace now replaces). SSR-seed the validation-reports table so it
// renders 10 rows on first paint instead of waiting for client hydration + a backtest
// results round-trip.
async function fetchInitialReports(): Promise<Array<Record<string, unknown>> | null> {
  try {
    const r = await authedFetch('/admin/api/backtest/results?limit=10')
    if (!r.ok) return null
    const d = (await r.json()) as { results?: Array<Record<string, unknown>> }
    return d.results ?? []
  } catch {
    return null
  }
}

export async function BacktestsTab() {
  const initialReports = await fetchInitialReports()
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-400">
        Queue walk-forward backtests and permutation-tested (MCPT) validations — both run as
        background jobs (parallelised across cores) with a live progress tracker + ETA; watch them
        in the Jobs table below. Results persist to MongoDB and <span className="text-gray-300">inform</span>{' '}
        the live-trading decision — they do not auto-open it. The gate is a separate manual
        step (the <code className="text-gray-300">trading:live_approved</code> Redis flag).
      </p>

      {/* The walk-forward / MCPT runners + their PBO/DSR/permutation-test report internals are
          quant-only — Beginner mode hides the validation machinery (and the feature-importance
          audit) and shows the explainer above instead. Nothing here is operationally critical. */}
      <QuantOnly>
        <ResearchView initialReports={initialReports} />

        <FeatureAuditPanel />
      </QuantOnly>
    </div>
  )
}
