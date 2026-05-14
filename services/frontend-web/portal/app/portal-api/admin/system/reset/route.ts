import { NextRequest, NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const upstream = await authedFetch('/api/admin/system/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
