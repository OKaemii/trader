import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Thin proxy → signal-service research module GET /admin/api/market/summary (sector returns +
// factor leadership + breadth + concentration). signal-service owns the /admin/api/market/* prefix.
export async function GET() {
  const upstream = await authedFetch('/admin/api/market/summary')
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
