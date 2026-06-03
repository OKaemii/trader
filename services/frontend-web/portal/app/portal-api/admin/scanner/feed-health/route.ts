import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Scanner feed-health proxy → market-data-service /admin/api/market-data/scanner/feed-health.
export async function GET() {
  const r = await authedFetch('/admin/api/market-data/scanner/feed-health')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
