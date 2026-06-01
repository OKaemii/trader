import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Per-strategy tunable config proxy → strategy-engine /admin/api/strategy/config.
// Browser → /portal-api/... → authedFetch through nginx → strategy-engine. JWT stays server-side.
export async function GET() {
  const r = await authedFetch('/admin/api/strategy/config')
  const body = await r.json().catch(() => ({ strategies: [], active: '' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}

export async function PUT(req: Request) {
  const payload = await req.json().catch(() => ({}))
  const r = await authedFetch('/admin/api/strategy/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
