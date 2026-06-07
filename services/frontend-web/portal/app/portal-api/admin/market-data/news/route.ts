import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Proxy for the news admin endpoint — the stored EODHD news articles for one ticker (the Overview
// "Recent Events" panel + the narrative/"Why?" event context). The client component hits this rather
// than the ingress directly; authedFetch attaches the session JWT and routes to market-data-service.
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker') ?? ''
  const upstream = await authedFetch(
    `/admin/api/market-data/news?ticker=${encodeURIComponent(ticker)}`,
  )
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
