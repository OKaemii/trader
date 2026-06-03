import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Refresh fundamentals (QMJ) for the active universe → /admin/api/market-data/fundamentals/refresh.
// Empty body => the service refreshes the whole active universe.
export async function POST() {
  const r = await authedFetch('/admin/api/market-data/fundamentals/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
