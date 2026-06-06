import { NextResponse, type NextRequest } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET() {
  const upstream = await authedFetch('/admin/api/signals/alerts')
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}

export async function POST(req: NextRequest) {
  const body = await req.text()
  const upstream = await authedFetch('/admin/api/signals/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
