import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Thin proxy → signal-service research module GET/PUT/DELETE /admin/api/research/notes/:ticker (the
// research notebook; T33 §G). signal-service owns the /admin/api/research/* prefix.
//   GET    → { ticker, body, links: [{kind,ref}], updatedBy, updatedAt }  (empty-but-200 when absent)
//   PUT    → upsert markdown body; server parses @-links into `links`; echoes the saved note
//   DELETE → { ticker, deleted }
// Next 16: dynamic route params are a Promise.

export async function GET(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const upstream = await authedFetch(`/admin/api/research/notes/${encodeURIComponent(ticker)}`)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const body = await req.text()
  const upstream = await authedFetch(`/admin/api/research/notes/${encodeURIComponent(ticker)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params
  const upstream = await authedFetch(`/admin/api/research/notes/${encodeURIComponent(ticker)}`, { method: 'DELETE' })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
