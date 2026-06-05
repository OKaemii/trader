import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: NextRequest) {
  const days = req.nextUrl.searchParams.get('days') ?? '30'
  const upstream = await authedFetch(`/admin/api/market-data/earnings/upcoming?days=${encodeURIComponent(days)}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
