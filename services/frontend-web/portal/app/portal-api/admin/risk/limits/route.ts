import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Operator-tunable risk limits → signal-service /admin/api/signals/risk/limits.
// GET: effective + overrides + defaults + tunable field list + bounds (for the editor).
// PUT: { overrides } — validated + bounded server-side, hot-applied (config:invalidated broadcast).
export async function GET() {
  const r = await authedFetch('/admin/api/signals/risk/limits')
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}

export async function PUT(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/signals/risk/limits', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
