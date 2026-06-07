import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Proxy for the technical-indicator admin endpoint — EODHD's supplemental technical overlays
// (MACD/ADX/ATR/Bollinger/beta) for the History page (T28, §H). Display/supplement only; the
// trading factors stay in quant-core. The client component hits this rather than the ingress
// directly; authedFetch attaches the session JWT and routes to market-data-service. The upstream
// validates the func allow-list + degrades to empty points on budget exhaustion — both passed
// through here. Browser → /portal-api/... → authedFetch → market-data-service.
export async function GET(req: NextRequest) {
  const ticker = req.nextUrl.searchParams.get('ticker') ?? ''
  const func = req.nextUrl.searchParams.get('func') ?? ''
  const period = req.nextUrl.searchParams.get('period') ?? ''
  const qs = new URLSearchParams()
  if (ticker) qs.set('ticker', ticker)
  if (func) qs.set('func', func)
  if (period) qs.set('period', period)
  const upstream = await authedFetch(`/admin/api/market-data/technical?${qs.toString()}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
