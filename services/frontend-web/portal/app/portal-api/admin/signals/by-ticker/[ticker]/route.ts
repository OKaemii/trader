import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Per-symbol signal history (Research workspace Signals tab). Proxies signal-service
// /admin/api/signals/by-ticker/:ticker → { ticker, signals: TradeSignal[] } (newest-first,
// ALL lifecycles incl. failed/cancelled — it's a per-symbol audit trail, not a tradeable feed).
// signal-service owns this prefix, so authedFetch forwards the user's JWT straight through the
// ingress (no cross-service /internal hop). The dynamic route param is a Promise in Next 16.
export async function GET(req: Request, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  if (!ticker) {
    return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  }
  const { searchParams } = new URL(req.url)
  const limit = searchParams.get('limit') ?? ''
  const qs = new URLSearchParams()
  if (limit) qs.set('limit', limit)
  const suffix = qs.toString()
  const r = await authedFetch(
    `/admin/api/signals/by-ticker/${encodeURIComponent(ticker)}${suffix ? `?${suffix}` : ''}`,
  )
  const body = await r.json().catch(() => ({ ticker, signals: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
