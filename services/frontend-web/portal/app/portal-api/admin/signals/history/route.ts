import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Recent signals for the feature-audit picker (so the operator doesn't hand-type
// strategy_id + timestamp). Proxies signal-service /admin/api/signals/history.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit') ?? '50'
  const r = await authedFetch(`/admin/api/signals/history?limit=${encodeURIComponent(limit)}`)
  const body = await r.json().catch(() => ({ signals: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
