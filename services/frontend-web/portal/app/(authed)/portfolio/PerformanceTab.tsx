import { authedFetch } from '@/app/lib/auth-fetch'
import { getSystemHealth } from '@/app/lib/system-health'
import { EquityView, type EquityPayload } from '@/components/EquityView'

// Performance tab (Portfolio workspace) — the body of the old /operations/performance page
// verbatim: equity curve + realised KPIs from the NAV ledger (nav_history, demo/live), plus a
// live service-health strip (G2). SSR-seeds both; the equity view re-fetches on range change.
// Service health comes from the shared getSystemHealth() fan-out (server components can't fetch
// their own /portal-api/* route); it always resolves to a full HealthRow[].
export async function PerformanceTab() {
  const [eqRes, health] = await Promise.all([
    authedFetch('/admin/api/trading/equity?days=90'),
    getSystemHealth(),
  ])
  const equity: EquityPayload | null = eqRes.ok ? await eqRes.json().catch(() => null) : null

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        Equity curve + realised KPIs from the NAV ledger (demo/live), and live service health. Annualised
        risk-adjusted metrics live in the backtest validator — not inferred from the NAV prints here.
      </p>

      <div className="flex flex-wrap gap-2">
        {health.length === 0 ? (
          <span className="text-xs text-gray-500">Service health unavailable.</span>
        ) : (
          health.map((s) => (
            <span
              key={s.name}
              className={`rounded px-2 py-1 text-xs font-medium ${s.ok ? 'bg-emerald-950 text-emerald-300' : 'bg-red-950 text-red-300'}`}
            >
              {s.ok ? '●' : '○'} {s.name}{!s.ok && s.status ? ` (${s.status})` : ''}
            </span>
          ))
        )}
      </div>

      {equity ? (
        <EquityView initial={equity} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {eqRes.status === 400
            ? 'NAV history is only recorded in demo/live mode — paper mode has no broker NAV to chart.'
            : eqRes.status === 401 || eqRes.status === 403
              ? 'Admin role required.'
              : `Equity data unavailable (${eqRes.status}).`}
        </div>
      )}
    </div>
  )
}
