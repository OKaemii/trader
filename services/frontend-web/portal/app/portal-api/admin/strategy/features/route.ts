import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Feature-audit proxy: forwards strategy_id + as_of_ms to strategy-engine's
// /admin/api/strategy/features (as-of FeatureVector read). Browser → /portal-api/... →
// authedFetch through nginx → strategy-engine. Keeps the JWT server-side.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const strategyId = searchParams.get('strategy_id') ?? ''
  const asOfMs = searchParams.get('as_of_ms') ?? '0'
  const r = await authedFetch(
    `/admin/api/strategy/features?strategy_id=${encodeURIComponent(strategyId)}&as_of_ms=${encodeURIComponent(asOfMs)}`,
  )
  const body = await r.json().catch(() => ({ found: false, reason: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
