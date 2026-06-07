import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Factor-scores proxy → strategy-engine /admin/api/strategy/scores (the factor_scores reader).
// Forwards the optional ticker + asOf (point-in-time knowledge cutoff) query params:
//   (none)                → all-universe latest map { ticker: {observation_ts, factors} }
//   ?ticker=X             → that name's newest row
//   ?ticker=X&asOf=<ms>   → the as-of row (signal "Why?" reads as-of signal.timestamp)
// Browser → /portal-api/... → authedFetch through nginx → strategy-engine. JWT stays server-side.
// Upstream degrades a pre-backfill / unknown-ticker read to {}; this proxy passes that through
// (an empty object is a valid, non-error response — the Research surface renders "no scores yet").
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker') ?? ''
  const asOf = searchParams.get('asOf') ?? ''
  const qs = new URLSearchParams()
  if (ticker) qs.set('ticker', ticker)
  if (asOf) qs.set('asOf', asOf)
  const suffix = qs.toString()
  const r = await authedFetch(`/admin/api/strategy/scores${suffix ? `?${suffix}` : ''}`)
  const body = await r.json().catch(() => ({}))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
