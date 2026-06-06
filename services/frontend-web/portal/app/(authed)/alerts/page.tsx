import { authedFetch } from '@/app/lib/auth-fetch'
import { AlertsView, type AlertRule } from './AlertsView'

// Alerts — price-alert rules (manual + auto-derived from trade-plan stops/targets). The whole point
// of swing trading is not watching the screen, so a crossed level pushes to the phone (#30/#32).
export default async function AlertsPage() {
  const r = await authedFetch('/admin/api/signals/alerts')
  const data = r.ok ? await r.json().catch(() => null) : null
  const rules: AlertRule[] = data?.rules ?? []

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Alerts</h1>
        <p className="text-sm text-gray-400">
          Price alerts pushed to your phone — entry triggers, stops approached, targets hit. Stop and
          target rules are created automatically when you set a trade plan; add manual rules below.
        </p>
      </div>
      {r.ok ? (
        <AlertsView initial={rules} />
      ) : (
        <div className="rounded border border-amber-900 bg-amber-950 px-4 py-2 text-sm text-amber-300">
          {r.status === 401 || r.status === 403 ? 'Admin role required.' : `Alerts unavailable (${r.status}).`}
        </div>
      )}
    </div>
  )
}
