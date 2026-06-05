import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET() {
  const upstream = await authedFetch('/admin/api/market-data/screener/thresholds')
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}

export async function PUT(req: NextRequest) {
  const body = await req.text()
  const upstream = await authedFetch('/admin/api/market-data/screener/thresholds', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
