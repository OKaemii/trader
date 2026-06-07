import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Thin proxy → signal-service research module GET /admin/api/market/narrative (the data-grounded
// hybrid market-state prose; T30). Returns { narrative, source, asOf, tradingDay, cached, summary }.
// The narrative is constrained to the numbers in /admin/api/market/summary; `source` is 'llm' when
// the LLM phrasing passed the post-check, 'template' on the deterministic fallback. `?refresh=1`
// forces regeneration (otherwise the day's cached narrative is served). signal-service owns the
// /admin/api/market/* prefix.
export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get('refresh')
  const qs = refresh === '1' || refresh === 'true' ? '?refresh=1' : ''
  const upstream = await authedFetch(`/admin/api/market/narrative${qs}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
