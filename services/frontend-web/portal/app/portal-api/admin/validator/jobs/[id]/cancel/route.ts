import { NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Cancel a queued/running validation or backtest job. Queued → cancelled immediately; running →
// cooperative stop at the next loop boundary. Next 16: dynamic route params are a Promise.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const upstream = await authedFetch(`/admin/api/validator/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
