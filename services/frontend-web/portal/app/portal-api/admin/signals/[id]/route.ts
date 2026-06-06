import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Thin proxy → signal-service GET /admin/api/signals/:id. Backs the /signals/[id]
// detail page (and the notification-email deep link). Next 16: dynamic route params
// are a Promise.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const upstream = await authedFetch(`/admin/api/signals/${encodeURIComponent(id)}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
