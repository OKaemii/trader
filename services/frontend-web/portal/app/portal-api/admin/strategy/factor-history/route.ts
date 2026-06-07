import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Factor-history proxy → strategy-engine /admin/api/strategy/factor-history. Forwards the ticker
// (required) + optional limit, returning the time-series of the four factor percentiles over
// observation_ts for the Factor-Evolution chart (T28):
//   { ticker, points: [{ observation_ts, momentum, quality, value, volatility }, …] }
// Browser → /portal-api/... → authedFetch through nginx → strategy-engine. JWT stays server-side.
// A missing ticker / pre-backfill store yields { ticker, points: [] } upstream — passed through.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker') ?? ''
  const limit = searchParams.get('limit') ?? ''
  const qs = new URLSearchParams()
  if (ticker) qs.set('ticker', ticker)
  if (limit) qs.set('limit', limit)
  const suffix = qs.toString()
  const r = await authedFetch(`/admin/api/strategy/factor-history${suffix ? `?${suffix}` : ''}`)
  const body = await r.json().catch(() => ({ ticker, points: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
