import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// Recent harvester sweep history → fundamentals-HARVESTER /admin/api/fundamentals-ingest/runs. Returns
// { runs:[{date, ciks}], count } newest-first (the CIK COUNT per sweep date, not the id list). Backs the
// Operations panel's "Recent sweeps" list. A lake that has never swept returns an empty list. Read-only.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/runs')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
