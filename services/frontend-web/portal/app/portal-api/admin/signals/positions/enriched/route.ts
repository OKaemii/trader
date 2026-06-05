import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function GET() {
  const upstream = await authedFetch('/admin/api/signals/positions/enriched')
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
