import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Flatten-all → trading-service /admin/api/trading/flatten. Cancels resting orders + market-sells
// all positions (demo/live only).
export async function POST() {
  const r = await authedFetch('/admin/api/trading/flatten', { method: 'POST' })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
