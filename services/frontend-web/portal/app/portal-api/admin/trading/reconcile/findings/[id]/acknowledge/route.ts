import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Acknowledge an open finding. Next 15+ dynamic params are a Promise (see portal AGENTS.md).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const body = await req.json().catch(() => ({}))
  const r = await authedFetch(`/admin/api/trading/reconcile/findings/${encodeURIComponent(id)}/acknowledge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(out, { status: r.ok ? 200 : r.status })
}
