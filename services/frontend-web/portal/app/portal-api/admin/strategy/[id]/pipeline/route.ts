import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Strategy-Lab pipeline funnel proxy → strategy-engine /admin/api/strategy/<id>/pipeline (T37 §G).
// Returns the declarative funnel stages + live counts ({ strategy_id, active, stages:[{key,label,
// count}] }) the Build→Strategy PipelineFunnel renders. Browser → /portal-api/... → authedFetch
// through nginx → strategy-engine; the JWT stays server-side. Next 16: dynamic params are a Promise.
// Upstream degrades a pre-cycle read to zero-count stages (never 404/500); this proxy passes that
// through so the funnel always renders its shape.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const upstream = await authedFetch(`/admin/api/strategy/${encodeURIComponent(id)}/pipeline`)
  const data = await upstream.json().catch(() => ({ strategy_id: id, active: '', stages: [] }))
  return NextResponse.json(data, { status: upstream.ok ? 200 : upstream.status })
}
