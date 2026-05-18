import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Fan-out aggregator. Replaces the deleted api-gateway's /api/admin/system/health.
// Each service is probed directly through nginx-ingress — /health endpoints are
// unauthenticated, but we still send the user JWT (services ignore it for /health).
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

export async function GET() {
  const results = await Promise.allSettled(
    SERVICES.map(async ([name, path]) => {
      const r = await authedFetch(path)
      return { name, ok: r.ok, status: r.status }
    }),
  )
  return NextResponse.json(
    results.map((r, i) => r.status === 'fulfilled' ? r.value : { name: SERVICES[i]![0], ok: false, status: 0 }),
  )
}
