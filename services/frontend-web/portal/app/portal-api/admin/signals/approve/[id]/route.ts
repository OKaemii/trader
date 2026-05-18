import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const upstream = await authedFetch(`/admin/api/signals/approve/${encodeURIComponent(id)}`, {
    method: 'POST',
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
