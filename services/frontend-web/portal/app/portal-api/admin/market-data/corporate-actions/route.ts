import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Proxy for the corporate-actions admin endpoint — the stored dividend + split lists for one ticker
// (the History page corporate-actions list). The client component hits this rather than the ingress
// directly; authedFetch attaches the session JWT and routes to market-data-service.
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker') ?? ''
  const upstream = await authedFetch(
    `/admin/api/market-data/corporate-actions?ticker=${encodeURIComponent(ticker)}`,
  )
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
