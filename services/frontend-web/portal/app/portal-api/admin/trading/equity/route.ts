import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Equity curve + performance KPIs → trading-service /admin/api/trading/equity.
// Demo/live only (paper mode has no broker NAV history → upstream returns 400).
export async function GET(req: Request) {
  const days = new URL(req.url).searchParams.get('days') ?? '90'
  const r = await authedFetch(`/admin/api/trading/equity?days=${encodeURIComponent(days)}`)
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
