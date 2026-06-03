import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Trade-audit fills feed → trading-service /admin/api/trading/fills (demo/live).
export async function GET(req: Request) {
  const qs = new URL(req.url).searchParams
  const params = new URLSearchParams()
  for (const k of ['ticker', 'side', 'days', 'limit']) {
    const v = qs.get(k)
    if (v) params.set(k, v)
  }
  const r = await authedFetch(`/admin/api/trading/fills?${params.toString()}`)
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
