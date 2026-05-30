import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// NAV history snapshots. Proxies trading-service /admin/api/trading/reconcile/nav.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit') ?? '200'
  const r = await authedFetch(`/admin/api/trading/reconcile/nav?limit=${encodeURIComponent(limit)}`)
  const body = await r.json().catch(() => ({ nav: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
