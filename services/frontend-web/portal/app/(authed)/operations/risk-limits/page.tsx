import { authedFetch } from '@/app/lib/auth-fetch'
import { RiskLimitsEditor, type RiskLimitsView } from './RiskLimitsEditor'

// Risk Limits — the operator-tunable RISK_LIMITS overlay (circuit-breaker halt thresholds +
// optimiser caps), stored in portal_risk_config and applied hot (no redeploy). SSR-seeds the
// effective/override/default snapshot; the client component edits + re-reads. Structural fields
// (vol target ← VOL_TARGET, confidence ← MIN_ACTIONABLE_CONFIDENCE) are set via Helm, not here.
export default async function RiskLimitsPage() {
  const r = await authedFetch('/admin/api/signals/risk/limits')
  const view: RiskLimitsView | null = r.ok ? await r.json() : null

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Risk Limits</h1>
        <p className="text-sm text-gray-400">
          Operator-tunable limits applied hot (no redeploy): circuit-breaker halt thresholds + optimiser caps.
          Each field is independent — clear it to fall back to the compile-time default.
        </p>
      </div>
      {!view ? (
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Risk-limits state unavailable (${r.status}).`}
        </div>
      ) : (
        <RiskLimitsEditor initial={view} />
      )}
    </div>
  )
}
