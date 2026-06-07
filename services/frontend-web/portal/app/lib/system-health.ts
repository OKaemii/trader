import 'server-only'
import { authedFetch } from '@/app/lib/auth-fetch'

// Shared system-health fan-out. The deleted api-gateway used to expose
// /api/admin/system/health; there is no backend /admin/api/system/* route, so the portal
// IS the aggregator. This module owns the single fan-out so it isn't duplicated across the
// client proxy route + the server-component callers.
//
// Each service is probed directly through nginx-ingress — /health endpoints are
// unauthenticated, but we still send the user JWT (services ignore it for /health).
//
// `import 'server-only'` is load-bearing: this pulls in authedFetch (which reads the
// session cookies), so it must never be imported into a client component. The client
// StrategyHealthBanner stays on the /portal-api/admin/system/health proxy instead.

export interface HealthRow {
  name: string
  ok: boolean
  status?: number
}

const SERVICES: ReadonlyArray<readonly [string, string]> = [
  ['auth',          '/api/auth/health'],
  ['signals',       '/api/signals/health'],
  ['portfolio',     '/api/portfolio/health'],
  ['notifications', '/api/notifications/health'],
  ['trading',       '/admin/api/trading/health'],
  ['market-data',   '/admin/api/market-data/health'],
  ['strategy',      '/admin/api/strategy/status'],
  ['backtest',      '/admin/api/backtest/health'],
]

// Always resolves to a full HealthRow[] — Promise.allSettled + per-service catch means a
// down service is a `{ ok: false }` row, never a thrown 404. Callers can drop any
// "endpoint unavailable" branch.
export async function getSystemHealth(): Promise<HealthRow[]> {
  const results = await Promise.allSettled(
    SERVICES.map(async ([name, path]) => {
      const r = await authedFetch(path)
      return { name, ok: r.ok, status: r.status }
    }),
  )
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: SERVICES[i]![0], ok: false, status: 0 },
  )
}
