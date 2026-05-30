import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Open (or all) reconciliation findings. Proxies trading-service /admin/api/trading/reconcile/findings.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const open = searchParams.get('open') ?? 'true'
  const limit = searchParams.get('limit') ?? '100'
  const r = await authedFetch(
    `/admin/api/trading/reconcile/findings?open=${encodeURIComponent(open)}&limit=${encodeURIComponent(limit)}`,
  )
  const body = await r.json().catch(() => ({ findings: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
