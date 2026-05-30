import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Force a reconciliation cycle now. Proxies trading-service /admin/api/trading/reconcile/run.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/trading/reconcile/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(out, { status: r.ok ? 200 : r.status })
}
