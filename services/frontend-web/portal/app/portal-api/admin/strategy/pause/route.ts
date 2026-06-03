import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Strategy pause → signal-service /admin/api/signals/strategy/pause. Halts emission only;
// the dispatcher keeps draining in-flight orders.
export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/signals/strategy/pause', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
