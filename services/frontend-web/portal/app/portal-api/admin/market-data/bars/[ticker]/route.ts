import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Next 16: dynamic params are a Promise. Forwards interval/range to the market-data bars endpoint.
export async function GET(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const interval = req.nextUrl.searchParams.get('interval') ?? 'daily'
  const range = req.nextUrl.searchParams.get('range') ?? '1y'
  const qs = `interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`
  const upstream = await authedFetch(`/admin/api/market-data/bars/${encodeURIComponent(ticker)}?${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
