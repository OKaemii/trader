import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Trigger a universe rebuild (runs the EODHD scan) → /admin/api/market-data/scanner/run.
export async function POST() {
  const r = await authedFetch('/admin/api/market-data/scanner/run', { method: 'POST' })
  const body = await r.json().catch(() => ({ error: 'bad upstream response' }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
