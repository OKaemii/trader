import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const limit = url.searchParams.get('limit')
  const path = `/api/signals/progress${limit ? `?limit=${encodeURIComponent(limit)}` : ''}`
  const upstream = await authedFetch(path)
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
