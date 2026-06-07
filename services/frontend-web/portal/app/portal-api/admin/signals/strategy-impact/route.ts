import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Strategy Impact tab data (Research workspace). Proxies signal-service
// /admin/api/signals/strategy-impact?ticker= → per-strategy { currentRank, historicalInclusionPct,
// avgHoldingDays, contributionPct, selected }. signal-service owns this prefix, so authedFetch
// forwards the user's JWT straight through the ingress.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker') ?? ''
  if (!ticker) {
    return NextResponse.json({ error: 'ticker query param required' }, { status: 400 })
  }
  const r = await authedFetch(`/admin/api/signals/strategy-impact?ticker=${encodeURIComponent(ticker)}`)
  const body = await r.json().catch(() => ({ ticker, strategies: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
