import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Active pie for a strategy → signal-service /admin/api/signals/pies/strategy/:strategyId.
export async function GET(_req: Request, ctx: { params: Promise<{ strategyId: string }> }) {
  const { strategyId } = await ctx.params
  const r = await authedFetch(`/admin/api/signals/pies/strategy/${encodeURIComponent(strategyId)}`)
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
