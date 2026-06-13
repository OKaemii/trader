import { NextResponse } from 'next/server'
import { authedFetch } from '@/app/lib/auth-fetch'

// PIT-fundamentals harvester status → fundamentals-HARVESTER /admin/api/fundamentals-ingest/status.
// Lake state: bootstrap_complete + bootstrap{completed_at,entities,mode}, covered_ciks, last_sweep_date
// + last_sweep_ciks, lake_size_bytes, has_ticker_history/has_entities. The Operations PIT-fundamentals
// panel header. snake_case payload — surfaced as-is.
export async function GET() {
  const r = await authedFetch('/admin/api/fundamentals-ingest/status')
  const body = await r.json().catch(() => null)
  return NextResponse.json(body, { status: r.ok ? 200 : r.status })
}
