import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

export async function POST() {
  const upstream = await authedFetch('/admin/api/signals/risk/circuit-breaker/reset', {
    method: 'POST',
  })
  const data = await upstream.json().catch(() => ({}))
  return NextResponse.json(data, { status: upstream.status })
}
