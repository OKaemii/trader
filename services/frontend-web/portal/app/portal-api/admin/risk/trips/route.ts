import { type NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: NextRequest) {
  const limit = req.nextUrl.searchParams.get('limit') ?? '50'
  const upstream = await authedFetch(`/admin/api/signals/risk/trips?limit=${encodeURIComponent(limit)}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
