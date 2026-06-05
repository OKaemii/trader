import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Next 16: dynamic route params are a Promise.
export async function PUT(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const body = await req.text()
  const upstream = await authedFetch(`/admin/api/signals/trade-plans/${encodeURIComponent(ticker)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const upstream = await authedFetch(`/admin/api/signals/trade-plans/${encodeURIComponent(ticker)}`, { method: 'DELETE' })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
