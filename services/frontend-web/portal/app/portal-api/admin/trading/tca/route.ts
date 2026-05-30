import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// TCA summary + recent rows. Proxies trading-service /admin/api/trading/tca.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit') ?? '100'
  const r = await authedFetch(`/admin/api/trading/tca?limit=${encodeURIComponent(limit)}`)
  const body = await r.json().catch(() => ({ daily: [], recent: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
