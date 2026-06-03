import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Active-strategy selection proxy → strategy-engine /admin/api/strategy/active. One strategy
// runs at a time; the selection persists and applies on the next strategy-engine restart.
export async function PUT(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/strategy/active', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
