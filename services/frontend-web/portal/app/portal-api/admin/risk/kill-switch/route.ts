import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Global kill switch → signal-service /admin/api/signals/risk/kill-switch. Halts new emission
// AND the trading-service dispatcher drain.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/signals/risk/kill-switch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
