import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: NextRequest) {
  const tickers = req.nextUrl.searchParams.get('tickers') ?? ''
  const days = req.nextUrl.searchParams.get('days') ?? '10'
  const qs = `tickers=${encodeURIComponent(tickers)}&days=${encodeURIComponent(days)}`
  const upstream = await authedFetch(`/admin/api/market-data/earnings/overlap?${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
