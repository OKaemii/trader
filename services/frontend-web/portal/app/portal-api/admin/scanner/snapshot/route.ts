import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Market scanner snapshot proxy → market-data-service /admin/api/market-data/scanner/snapshot.
export async function GET() {
  const r = await authedFetch('/admin/api/market-data/scanner/snapshot')
  const body = await r.json().catch(() => ({ universeSize: 0, qualityKnown: 0, qualityPassCount: 0, rows: [] }))
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
